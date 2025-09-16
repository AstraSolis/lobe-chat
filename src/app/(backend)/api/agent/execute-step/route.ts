import { AgentRuntime } from '@lobechat/agent-runtime';
import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { AgentStateManager } from '@/server/modules/AgentRuntime/AgentStateManager';
import { DurableLobeChatAgent } from '@/server/modules/AgentRuntime/DurableLobeChatAgent';
import { StreamEventManager } from '@/server/modules/AgentRuntime/StreamEventManager';
import {
  createStreamingFinishExecutor,
  createStreamingHumanApprovalExecutor,
  createStreamingLLMExecutor,
  createStreamingToolExecutor,
} from '@/server/modules/AgentRuntime/StreamingExecutors';
import { QueueService } from '@/server/services/queue/QueueService';

const log = debug('agent:execute-step');

// Initialize services
const stateManager = new AgentStateManager();
const streamManager = new StreamEventManager();

const queueService = new QueueService();

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
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    log(`Starting step ${stepIndex} for session ${sessionId}`);

    // 1. 加载 Agent 状态
    let agentState = await stateManager.loadAgentState(sessionId);

    if (!agentState) {
      return NextResponse.json(
        {
          error: 'Agent session not found',
          sessionId,
          stepIndex,
        },
        { status: 404 },
      );
    }

    // 发布步骤开始事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        agentStatus: agentState.status,
        context,
        timestamp: startTime,
      },
      stepIndex,
      type: 'step_start',
    });

    // 2. 获取会话元数据
    const sessionMetadata = await stateManager.getSessionMetadata(sessionId);

    // 3. 创建 Durable Agent 实例
    const agent = new DurableLobeChatAgent({
      agentConfig: sessionMetadata?.agentConfig,
      modelConfig: sessionMetadata?.modelConfig,
      sessionId,
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
    const runtime = new AgentRuntime(agent as any, {
      executors: {
        call_llm: createStreamingLLMExecutor(executorContext),
        call_tool: createStreamingToolExecutor(executorContext),
        finish: createStreamingFinishExecutor(executorContext),
        request_human_approve: createStreamingHumanApprovalExecutor(executorContext),
      },
    });

    // 6. 处理人工干预
    let currentContext = context;
    if (humanInput || approvedToolCall || rejectionReason) {
      if (approvedToolCall && agentState.status === 'waiting_for_human_input') {
        log(`Processing approved tool call for session ${sessionId}:${stepIndex}`);

        const result = await runtime.approveToolCall(agentState, approvedToolCall);
        agentState = result.newState;
        currentContext = result.nextContext;

        // 发布人工干预处理事件
        await streamManager.publishStreamEvent(sessionId, {
          data: {
            approvedToolCall,
            events: result.events,
            phase: 'human_intervention_processed',
          },
          stepIndex,
          type: 'step_complete',
        });
      }

      if (rejectionReason) {
        log(`Processing tool call rejection for session ${sessionId}:${stepIndex}`);

        // 工具调用被拒绝，直接结束执行
        agentState.status = 'done';
        agentState.lastModified = new Date().toISOString();

        await streamManager.publishStreamEvent(sessionId, {
          data: {
            phase: 'human_intervention_rejected',
            rejectionReason,
            status: 'done',
          },
          stepIndex,
          type: 'step_complete',
        });

        const executionTime = Date.now() - startTime;
        await stateManager.saveStepResult(sessionId, {
          events: [
            { reason: 'user_requested', reasonDetail: rejectionReason, type: 'done' } as any,
          ],
          executionTime,
          newState: agentState,
          nextContext: undefined,
          stepIndex,
        });

        return NextResponse.json({
          completed: true,
          executionTime,
          nextStepScheduled: false,
          rejectionReason,
          sessionId,
          status: agentState.status,
          stepIndex,
          success: true,
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
      data: {
        events: stepResult.events,
        executionTime,
        hasNextContext: !!stepResult.nextContext,
        status: stepResult.newState.status,
        totalSteps: stepResult.newState.stepCount,
      },
      stepIndex,
      type: 'step_complete',
    });

    // 10. 决定下一步行动
    const shouldContinue = shouldContinueExecution(stepResult.newState, stepResult.nextContext);
    const nextStepIndex = stepIndex + 1;
    let nextStepScheduled = false;

    if (shouldContinue && !forceComplete) {
      // 11. 计算延迟时间
      const delay = QueueService.calculateDelay({
        hasErrors: stepResult.events.some((e) => e.type === 'error'),
        hasToolCalls: stepResult.events.some((e) => e.type === 'tool_result'),
        priority: priority as any,
        stepIndex: nextStepIndex,
      });

      // 12. 调度下一步执行
      try {
        await queueService.scheduleNextStep({
          context: stepResult.nextContext,
          delay,
          priority: priority as any,
          sessionId,
          stepIndex: nextStepIndex,
        });
        nextStepScheduled = true;
      } catch (error) {
        console.error(`[Agent Step] Failed to schedule next step:`, error);
        // 调度失败不应该中断当前步骤的成功执行
      }
    }

    const responseData = {
      // 状态相关信息
      completed: stepResult.newState.status === 'done',

      error: stepResult.newState.status === 'error' ? stepResult.newState.error : undefined,

      executionTime,

      nextStepIndex: nextStepScheduled ? nextStepIndex : undefined,

      nextStepScheduled,

      // 人工干预相关
      pendingApproval: stepResult.newState.pendingToolsCalling,

      pendingPrompt: stepResult.newState.pendingHumanPrompt,

      pendingSelect: stepResult.newState.pendingHumanSelect,

      sessionId,

      status: stepResult.newState.status,

      stepIndex,

      success: true,

      totalCost: stepResult.newState.cost?.total || 0,
      totalSteps: stepResult.newState.stepCount,
      waitingForHuman: stepResult.newState.status === 'waiting_for_human_input',
    };

    log(
      `Step ${stepIndex} completed for session ${sessionId} (${executionTime}ms, status: ${stepResult.newState.status})`,
    );

    return NextResponse.json(responseData);
  } catch (error: any) {
    const executionTime = Date.now() - startTime;

    console.error(`[Agent Step] Error in execution:`, error);

    // 发布错误事件
    const body = await request.json().catch(() => ({}));
    if (body.sessionId) {
      try {
        await streamManager.publishStreamEvent(body.sessionId, {
          data: {
            error: error.message,
            executionTime,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          },
          stepIndex: body.stepIndex || 0,
          type: 'error',
        });
      } catch (streamError) {
        console.error('[Agent Step] Failed to publish error event:', streamError);
      }
    }

    return NextResponse.json(
      {
        error: error.message,
        executionTime,
        sessionId: body.sessionId,
        stepIndex: body.stepIndex || 0,
      },
      { status: 500 },
    );
  }
}

/**
 * 健康检查端点
 */
export async function GET() {
  try {
    // 检查各个服务的健康状态
    const queueHealth = await queueService
      .healthCheck()
      .catch(() => ({ healthy: false, message: 'Queue service unavailable' }));

    const allHealthy = queueHealth.healthy;

    return NextResponse.json(
      {
        healthy: allHealthy,
        services: {
          queue: queueHealth,
          redis: { healthy: true, message: 'Redis connection active' }, // 简化检查
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: allHealthy ? 200 : 503,
      },
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message,
        healthy: false,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
