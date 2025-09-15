import { NextRequest, NextResponse } from 'next/server';
import { AgentRuntime } from '@lobechat/agent-runtime';
import { DurableLobeChatAgent } from '@/server/agents/DurableLobeChatAgent';
import { AgentStateManager } from '@/server/services/agent/AgentStateManager';
import { StreamEventManager } from '@/server/services/agent/StreamEventManager';
import { QueueService } from '@/server/services/queue/QueueService';
import {
  createStreamingLLMExecutor,
  createStreamingToolExecutor,
  createStreamingHumanApprovalExecutor,
  createStreamingFinishExecutor,
} from '@/server/executors/StreamingExecutors';

// 初始化服务
const stateManager = new AgentStateManager({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  password: process.env.REDIS_PASSWORD,
  db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : 0,
});

const streamManager = new StreamEventManager({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  password: process.env.REDIS_PASSWORD,
  db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : 0,
});

const queueService = new QueueService({
  qstashToken: process.env.QSTASH_TOKEN!,
  endpoint: process.env.AGENT_STEP_ENDPOINT || `${process.env.NEXTAUTH_URL}/api/agent/execute-step`,
});

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();

    const {
      sessionId,
      stepIndex = 0,
      context,
      forceComplete = false,
      // 人工干预参数
      humanInput,
      approvedToolCall,
      rejectionReason,
      // 其他参数
      priority = 'normal',
    } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    console.log(`[Agent Step] Starting step ${stepIndex} for session ${sessionId}`);

    // 1. 加载 Agent 状态
    let agentState = await stateManager.loadAgentState(sessionId);

    if (!agentState) {
      return NextResponse.json({
        error: 'Agent session not found',
        sessionId,
        stepIndex,
      }, { status: 404 });
    }

    // 发布步骤开始事件
    await streamManager.publishStreamEvent(sessionId, {
      type: 'step_start',
      stepIndex,
      data: {
        context,
        agentStatus: agentState.status,
        timestamp: startTime,
      }
    });

    // 2. 获取会话元数据
    const sessionMetadata = await stateManager.getSessionMetadata(sessionId);

    // 3. 创建 Durable Agent 实例
    const agent = new DurableLobeChatAgent({
      sessionId,
      modelConfig: sessionMetadata?.modelConfig,
      agentConfig: sessionMetadata?.agentConfig,
      userId: sessionMetadata?.userId,
    });

    // 4. 创建流式执行器上下文
    const executorContext = {
      sessionId,
      stepIndex,
      streamManager,
      // 这里应该传入数据库模型实例
      // messageModel: new MessageModel(serverDB, userId),
      // fileService: new FileService(serverDB, userId),
      userId: sessionMetadata?.userId,
    };

    // 5. 创建 Agent Runtime 实例
    const runtime = new AgentRuntime(agent, {
      executors: {
        call_llm: createStreamingLLMExecutor(executorContext),
        call_tool: createStreamingToolExecutor(executorContext),
        request_human_approve: createStreamingHumanApprovalExecutor(executorContext),
        finish: createStreamingFinishExecutor(executorContext),
      }
    });

    // 6. 处理人工干预
    let currentContext = context;
    if (humanInput || approvedToolCall || rejectionReason) {
      if (approvedToolCall && agentState.status === 'waiting_for_human_input') {
        console.log(`[Agent Step] Processing approved tool call for session ${sessionId}:${stepIndex}`);

        const result = await runtime.approveToolCall(agentState, approvedToolCall);
        agentState = result.newState;
        currentContext = result.nextContext;

        // 发布人工干预处理事件
        await streamManager.publishStreamEvent(sessionId, {
          type: 'step_complete',
          stepIndex,
          data: {
            phase: 'human_intervention_processed',
            approvedToolCall,
            events: result.events,
          }
        });
      }

      if (rejectionReason) {
        console.log(`[Agent Step] Processing tool call rejection for session ${sessionId}:${stepIndex}`);

        // 工具调用被拒绝，直接结束执行
        agentState.status = 'done';
        agentState.lastModified = new Date().toISOString();

        await streamManager.publishStreamEvent(sessionId, {
          type: 'step_complete',
          stepIndex,
          data: {
            phase: 'human_intervention_rejected',
            rejectionReason,
            status: 'done',
          }
        });

        const executionTime = Date.now() - startTime;
        await stateManager.saveStepResult(sessionId, {
          events: [{ type: 'done', reason: 'rejected', reasonDetail: rejectionReason }],
          newState: agentState,
          nextContext: undefined,
          executionTime,
          stepIndex,
        });

        return NextResponse.json({
          success: true,
          sessionId,
          stepIndex,
          status: agentState.status,
          executionTime,
          nextStepScheduled: false,
          completed: true,
          rejectionReason,
        });
      }
    }

    // 7. 执行单步
    const stepResult = await runtime.step(agentState, currentContext);
    const executionTime = Date.now() - startTime;

    // 8. 保存状态和步骤结果
    await stateManager.saveStepResult(sessionId, {
      ...stepResult,
      executionTime,
      stepIndex,
    });

    // 9. 发布步骤完成事件
    await streamManager.publishStreamEvent(sessionId, {
      type: 'step_complete',
      stepIndex,
      data: {
        status: stepResult.newState.status,
        totalSteps: stepResult.newState.stepCount,
        executionTime,
        events: stepResult.events,
        hasNextContext: !!stepResult.nextContext,
      }
    });

    // 10. 决定下一步行动
    const shouldContinue = shouldContinueExecution(stepResult.newState, stepResult.nextContext);
    const nextStepIndex = stepIndex + 1;
    let nextStepScheduled = false;

    if (shouldContinue && !forceComplete) {
      // 11. 计算延迟时间
      const delay = QueueService.calculateDelay({
        stepIndex: nextStepIndex,
        hasErrors: stepResult.events.some(e => e.type === 'error'),
        hasToolCalls: stepResult.events.some(e => e.type === 'tool_result'),
        priority: priority as any,
      });

      // 12. 调度下一步执行
      try {
        await queueService.scheduleNextStep({
          sessionId,
          stepIndex: nextStepIndex,
          context: stepResult.nextContext,
          delay,
          priority: priority as any,
        });
        nextStepScheduled = true;
      } catch (error) {
        console.error(`[Agent Step] Failed to schedule next step:`, error);
        // 调度失败不应该中断当前步骤的成功执行
      }
    }

    const responseData = {
      success: true,
      sessionId,
      stepIndex,
      status: stepResult.newState.status,
      executionTime,
      nextStepScheduled,
      nextStepIndex: nextStepScheduled ? nextStepIndex : undefined,
      totalSteps: stepResult.newState.stepCount,
      totalCost: stepResult.newState.cost?.total || 0,
      // 状态相关信息
      completed: stepResult.newState.status === 'done',
      waitingForHuman: stepResult.newState.status === 'waiting_for_human_input',
      error: stepResult.newState.status === 'error' ? stepResult.newState.error : undefined,
      // 人工干预相关
      pendingApproval: stepResult.newState.pendingToolsCalling,
      pendingPrompt: stepResult.newState.pendingHumanPrompt,
      pendingSelect: stepResult.newState.pendingHumanSelect,
    };

    console.log(`[Agent Step] Step ${stepIndex} completed for session ${sessionId} (${executionTime}ms, status: ${stepResult.newState.status})`);

    return NextResponse.json(responseData);

  } catch (error: any) {
    const executionTime = Date.now() - startTime;

    console.error(`[Agent Step] Error in execution:`, error);

    // 发布错误事件
    const body = await request.json().catch(() => ({}));
    if (body.sessionId) {
      try {
        await streamManager.publishStreamEvent(body.sessionId, {
          type: 'error',
          stepIndex: body.stepIndex || 0,
          data: {
            error: error.message,
            executionTime,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          }
        });
      } catch (streamError) {
        console.error('[Agent Step] Failed to publish error event:', streamError);
      }
    }

    return NextResponse.json({
      error: error.message,
      sessionId: body.sessionId,
      stepIndex: body.stepIndex || 0,
      executionTime,
    }, { status: 500 });
  }
}

/**
 * 健康检查端点
 */
export async function GET() {
  try {
    // 检查各个服务的健康状态
    const [queueHealth] = await Promise.all([
      queueService.healthCheck().catch(() => ({ healthy: false, message: 'Queue service unavailable' }))
    ]);

    const allHealthy = queueHealth.healthy;

    return NextResponse.json({
      healthy: allHealthy,
      timestamp: new Date().toISOString(),
      services: {
        queue: queueHealth,
        redis: { healthy: true, message: 'Redis connection active' }, // 简化检查
      },
    }, {
      status: allHealthy ? 200 : 503
    });
  } catch (error: any) {
    return NextResponse.json({
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
}

/**
 * 决定是否继续执行
 */
function shouldContinueExecution(state: any, context?: any): boolean {
  // 已完成
  if (state.status === 'done') return false;

  // 需要人工干预
  if (state.status === 'waiting_for_human_input') return false;

  // 出错了
  if (state.status === 'error') return false;

  // 被中断
  if (state.status === 'interrupted') return false;

  // 达到最大步数
  if (state.maxSteps && state.stepCount >= state.maxSteps) return false;

  // 超过成本限制
  if (state.costLimit && state.cost?.total >= state.costLimit.maxTotalCost) {
    return state.costLimit.onExceeded !== 'stop';
  }

  // 没有下一个上下文
  if (!context) return false;

  return true;
}
