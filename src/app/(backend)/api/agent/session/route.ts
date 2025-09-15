import { NextRequest, NextResponse } from 'next/server';
import { AgentRuntime } from '@lobechat/agent-runtime';
import { DurableLobeChatAgent } from '@/server/agents/DurableLobeChatAgent';
import { AgentStateManager } from '@/server/services/agent/AgentStateManager';
import { StreamEventManager } from '@/server/services/agent/StreamEventManager';
import { QueueService } from '@/server/services/queue/QueueService';

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

/**
 * 创建新的 Agent 会话
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      messages = [],
      modelConfig = {},
      agentConfig = {},
      sessionId: providedSessionId,
      userId,
      // 立即开始执行
      autoStart = true,
    } = body;

    // 生成会话 ID
    const sessionId = providedSessionId || `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`[Agent Session] Creating session ${sessionId} for user ${userId}`);

    // 验证必需参数
    if (!modelConfig.model || !modelConfig.provider) {
      return NextResponse.json({
        error: 'modelConfig.model and modelConfig.provider are required',
      }, { status: 400 });
    }

    // 1. 创建 Agent 实例（用于验证配置）
    const agent = new DurableLobeChatAgent({
      sessionId,
      modelConfig,
      agentConfig,
      userId,
    });

    // 2. 创建初始 Agent 状态
    const initialState = AgentRuntime.createInitialState({
      sessionId,
      messages: messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
      })),
      metadata: {
        modelConfig,
        agentConfig,
        userId,
        createdAt: new Date().toISOString(),
      },
      // 可选的限制配置
      maxSteps: agentConfig.maxSteps || 100,
      costLimit: agentConfig.costLimit ? {
        maxTotalCost: agentConfig.costLimit.maxTotalCost || 10,
        currency: agentConfig.costLimit.currency || 'USD',
        onExceeded: agentConfig.costLimit.onExceeded || 'stop',
      } : undefined,
    });

    // 3. 保存初始状态
    await stateManager.saveAgentState(sessionId, initialState);

    // 4. 创建会话元数据
    await stateManager.createSessionMetadata(sessionId, {
      userId,
      modelConfig,
      agentConfig,
    });

    console.log(`[Agent Session] Session ${sessionId} created successfully`);

    // 5. 如果设置自动开始，触发第一步执行
    let firstStepResult;
    if (autoStart) {
      // 创建初始上下文
      const initialContext = {
        phase: 'user_input' as const,
        payload: {
          message: messages[messages.length - 1] || { content: '' },
          isFirstMessage: messages.length <= 1,
          sessionId,
        },
        session: {
          sessionId,
          stepCount: 0,
          messageCount: messages.length,
          eventCount: 0,
          status: 'idle' as const,
        }
      };

      try {
        // 调度第一步执行
        const messageId = await queueService.scheduleNextStep({
          sessionId,
          stepIndex: 0,
          context: initialContext,
          delay: 500, // 短延迟启动
          priority: 'high',
        });

        firstStepResult = {
          scheduled: true,
          messageId,
          context: initialContext,
        };

        console.log(`[Agent Session] First step scheduled for session ${sessionId} (messageId: ${messageId})`);
      } catch (error) {
        console.error(`[Agent Session] Failed to schedule first step for session ${sessionId}:`, error);

        firstStepResult = {
          scheduled: false,
          error: (error as Error).message,
        };
      }
    }

    return NextResponse.json({
      success: true,
      sessionId,
      status: 'created',
      autoStart,
      initialState: {
        status: initialState.status,
        stepCount: initialState.stepCount,
        messageCount: messages.length,
        costLimit: initialState.costLimit,
        maxSteps: initialState.maxSteps,
      },
      firstStep: firstStepResult,
      createdAt: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error(`[Agent Session] Failed to create session:`, error);

    return NextResponse.json({
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

/**
 * 获取会话状态
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const includeHistory = searchParams.get('includeHistory') === 'true';
    const historyLimit = parseInt(searchParams.get('historyLimit') || '10');

    if (!sessionId) {
      return NextResponse.json({
        error: 'sessionId parameter is required'
      }, { status: 400 });
    }

    // 1. 获取当前状态
    const [currentState, sessionMetadata] = await Promise.all([
      stateManager.loadAgentState(sessionId),
      stateManager.getSessionMetadata(sessionId),
    ]);

    if (!currentState || !sessionMetadata) {
      return NextResponse.json({
        error: 'Session not found'
      }, { status: 404 });
    }

    // 2. 获取执行历史（如果需要）
    let executionHistory;
    if (includeHistory) {
      executionHistory = await stateManager.getExecutionHistory(sessionId, historyLimit);
    }

    // 3. 获取最近的流式事件（用于调试）
    let recentEvents;
    if (includeHistory) {
      recentEvents = await streamManager.getStreamHistory(sessionId, 20);
    }

    // 4. 计算会话统计信息
    const stats = {
      totalSteps: currentState.stepCount,
      totalCost: currentState.cost?.total || 0,
      totalMessages: currentState.messages.length,
      totalEvents: currentState.events.length,
      uptime: sessionMetadata.createdAt
        ? Date.now() - new Date(sessionMetadata.createdAt).getTime()
        : 0,
      lastActiveTime: sessionMetadata.lastActiveAt
        ? Date.now() - new Date(sessionMetadata.lastActiveAt).getTime()
        : 0,
    };

    return NextResponse.json({
      sessionId,
      currentState: {
        status: currentState.status,
        stepCount: currentState.stepCount,
        lastModified: currentState.lastModified,
        cost: currentState.cost,
        usage: currentState.usage,
        // 人工干预相关
        pendingToolsCalling: currentState.pendingToolsCalling,
        pendingHumanPrompt: currentState.pendingHumanPrompt,
        pendingHumanSelect: currentState.pendingHumanSelect,
        // 限制相关
        maxSteps: currentState.maxSteps,
        costLimit: currentState.costLimit,
        // 错误信息
        error: currentState.error,
        interruption: currentState.interruption,
      },
      metadata: sessionMetadata,
      stats,
      // 可选的历史信息
      executionHistory: executionHistory?.slice(0, historyLimit),
      recentEvents: recentEvents?.slice(0, 10),
      // 状态判断
      isActive: ['running', 'waiting_for_human_input'].includes(currentState.status),
      isCompleted: currentState.status === 'done',
      hasError: currentState.status === 'error',
      needsHumanInput: currentState.status === 'waiting_for_human_input',
    });

  } catch (error: any) {
    console.error(`[Agent Session] Failed to get session status:`, error);

    return NextResponse.json({
      error: (error as Error).message
    }, { status: 500 });
  }
}

/**
 * 更新会话配置
 */
export async function PATCH(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json({
        error: 'sessionId parameter is required'
      }, { status: 400 });
    }

    const body = await request.json();
    const { modelConfig, agentConfig, maxSteps, costLimit } = body;

    // 1. 检查会话是否存在
    const currentState = await stateManager.loadAgentState(sessionId);
    if (!currentState) {
      return NextResponse.json({
        error: 'Session not found'
      }, { status: 404 });
    }

    // 2. 检查会话是否可以更新（运行中的会话可能不允许某些更新）
    if (currentState.status === 'running') {
      // 只允许更新某些非关键配置
      const allowedUpdates = { maxSteps, costLimit };
      const hasDisallowedUpdates = modelConfig || agentConfig;

      if (hasDisallowedUpdates) {
        return NextResponse.json({
          error: 'Cannot update model or agent config while session is running',
          currentStatus: currentState.status,
        }, { status: 409 });
      }
    }

    // 3. 更新会话状态
    const updatedState = { ...currentState };

    if (maxSteps !== undefined) {
      updatedState.maxSteps = maxSteps;
    }

    if (costLimit !== undefined) {
      updatedState.costLimit = costLimit;
    }

    updatedState.lastModified = new Date().toISOString();

    // 4. 保存更新后的状态
    await stateManager.saveAgentState(sessionId, updatedState);

    // 5. 更新元数据
    const sessionMetadata = await stateManager.getSessionMetadata(sessionId);
    if (sessionMetadata) {
      const updatedMetadata = { ...sessionMetadata };

      if (modelConfig) {
        updatedMetadata.modelConfig = { ...updatedMetadata.modelConfig, ...modelConfig };
      }

      if (agentConfig) {
        updatedMetadata.agentConfig = { ...updatedMetadata.agentConfig, ...agentConfig };
      }

      // 重新创建元数据（因为没有直接的更新方法）
      await stateManager.createSessionMetadata(sessionId, {
        userId: updatedMetadata.userId,
        modelConfig: updatedMetadata.modelConfig,
        agentConfig: updatedMetadata.agentConfig,
      });
    }

    console.log(`[Agent Session] Updated configuration for session ${sessionId}`);

    return NextResponse.json({
      success: true,
      sessionId,
      updatedAt: updatedState.lastModified,
      currentStatus: updatedState.status,
    });

  } catch (error: any) {
    console.error(`[Agent Session] Failed to update session:`, error);

    return NextResponse.json({
      error: (error as Error).message
    }, { status: 500 });
  }
}

/**
 * 删除会话
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json({
        error: 'sessionId parameter is required'
      }, { status: 400 });
    }

    // 1. 检查会话是否存在
    const currentState = await stateManager.loadAgentState(sessionId);
    if (!currentState) {
      return NextResponse.json({
        error: 'Session not found'
      }, { status: 404 });
    }

    // 2. 如果会话正在运行，先中断它
    if (currentState.status === 'running') {
      // 这里应该取消正在进行的任务
      // 由于 QStash 不支持直接取消，我们标记会话为中断状态
      const interruptedState = {
        ...currentState,
        status: 'interrupted',
        lastModified: new Date().toISOString(),
        interruption: {
          reason: 'Session deleted by user',
          canResume: false,
          interruptedAt: new Date().toISOString(),
        }
      };

      await stateManager.saveAgentState(sessionId, interruptedState);

      // 发布中断事件
      await streamManager.publishStreamEvent(sessionId, {
        type: 'error',
        stepIndex: currentState.stepCount,
        data: {
          reason: 'session_deleted',
          message: 'Session was deleted by user',
        }
      });
    }

    // 3. 删除所有相关数据
    await Promise.all([
      stateManager.deleteAgentSession(sessionId),
      streamManager.cleanupSession(sessionId),
    ]);

    console.log(`[Agent Session] Deleted session ${sessionId}`);

    return NextResponse.json({
      success: true,
      sessionId,
      deletedAt: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error(`[Agent Session] Failed to delete session:`, error);

    return NextResponse.json({
      error: (error as Error).message
    }, { status: 500 });
  }
}
