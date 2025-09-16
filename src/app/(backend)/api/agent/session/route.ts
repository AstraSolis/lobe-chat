import { AgentRuntime } from '@lobechat/agent-runtime';
import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { AgentStateManager } from '@/server/modules/AgentRuntime/AgentStateManager';
import { DurableLobeChatAgent } from '@/server/modules/AgentRuntime/DurableLobeChatAgent';
import { StreamEventManager } from '@/server/modules/AgentRuntime/StreamEventManager';
import { QueueService } from '@/server/services/queue/QueueService';

const log = debug('agent:session');

// Initialize services
const stateManager = new AgentStateManager();
const streamManager = new StreamEventManager();
const queueService = new QueueService();

/**
 * 创建新的 Agent 会话
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    log('Creating session with body:', body);
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
    const sessionId =
      providedSessionId || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    log(`Creating session ${sessionId} for user ${userId}`);

    // 验证必需参数
    if (!modelConfig.model || !modelConfig.provider) {
      return NextResponse.json(
        {
          error: 'modelConfig.model and modelConfig.provider are required',
        },
        { status: 400 },
      );
    }

    // 1. 创建 Agent 实例（用于验证配置）
    const agent = new DurableLobeChatAgent({
      agentConfig,
      modelConfig,
      sessionId,
      userId,
    });

    // 2. 创建初始 Agent 状态
    const initialState = AgentRuntime.createInitialState({
      costLimit: agentConfig.costLimit
        ? {
            currency: agentConfig.costLimit.currency || 'USD',
            maxTotalCost: agentConfig.costLimit.maxTotalCost || 10,
            onExceeded: agentConfig.costLimit.onExceeded || 'stop',
          }
        : undefined,

      // 可选的限制配置
      maxSteps: agentConfig.maxSteps || 100,

      messages: messages.map((m: any) => ({
        content: m.content,
        role: m.role,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
      })),

      metadata: {
        agentConfig,
        createdAt: new Date().toISOString(),
        modelConfig,
        userId,
      },
      sessionId,
    });

    // 3. 保存初始状态
    await stateManager.saveAgentState(sessionId, initialState);

    // 4. 创建会话元数据
    await stateManager.createSessionMetadata(sessionId, {
      agentConfig,
      modelConfig,
      userId,
    });

    log(`Session ${sessionId} created successfully`);

    // 5. 如果设置自动开始，触发第一步执行
    let firstStepResult;
    if (autoStart) {
      // 创建初始上下文
      const initialContext = {
        payload: {
          isFirstMessage: messages.length <= 1,
          message: messages.at(-1) || { content: '' },
          sessionId,
        },
        phase: 'user_input' as const,
        session: {
          eventCount: 0,
          messageCount: messages.length,
          sessionId,
          status: 'idle' as const,
          stepCount: 0,
        },
      };

      try {
        // 调度第一步执行
        const messageId = await queueService.scheduleNextStep({
          context: initialContext,
          delay: 500,
          // 短延迟启动
          priority: 'high',

          sessionId,
          stepIndex: 0,
        });

        firstStepResult = {
          context: initialContext,
          messageId,
          scheduled: true,
        };

        log(`First step scheduled for session ${sessionId} (messageId: ${messageId})`);
      } catch (error) {
        console.error('Failed to schedule first step for session %s:', sessionId, error);

        firstStepResult = {
          error: (error as Error).message,
          scheduled: false,
        };
      }
    }

    return NextResponse.json({
      autoStart,
      createdAt: new Date().toISOString(),
      firstStep: firstStepResult,
      initialState: {
        costLimit: initialState.costLimit,
        maxSteps: initialState.maxSteps,
        messageCount: messages.length,
        status: initialState.status,
        stepCount: initialState.stepCount,
      },
      sessionId,
      status: 'created',
      success: true,
    });
  } catch (error: any) {
    console.error('Failed to create session:', error);

    return NextResponse.json(
      {
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
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
      return NextResponse.json(
        {
          error: 'sessionId parameter is required',
        },
        { status: 400 },
      );
    }

    // 1. 获取当前状态
    const [currentState, sessionMetadata] = await Promise.all([
      stateManager.loadAgentState(sessionId),
      stateManager.getSessionMetadata(sessionId),
    ]);

    if (!currentState || !sessionMetadata) {
      return NextResponse.json(
        {
          error: 'Session not found',
        },
        { status: 404 },
      );
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
      lastActiveTime: sessionMetadata.lastActiveAt
        ? Date.now() - new Date(sessionMetadata.lastActiveAt).getTime()
        : 0,
      totalCost: currentState.cost?.total || 0,
      totalEvents: currentState.events.length,
      totalMessages: currentState.messages.length,
      totalSteps: currentState.stepCount,
      uptime: sessionMetadata.createdAt
        ? Date.now() - new Date(sessionMetadata.createdAt).getTime()
        : 0,
    };

    return NextResponse.json({
      currentState: {
        cost: currentState.cost,
        costLimit: currentState.costLimit,

        // 错误信息
        error: currentState.error,

        interruption: currentState.interruption,

        lastModified: currentState.lastModified,

        // 限制相关
        maxSteps: currentState.maxSteps,

        pendingHumanPrompt: currentState.pendingHumanPrompt,

        pendingHumanSelect: currentState.pendingHumanSelect,

        // 人工干预相关
        pendingToolsCalling: currentState.pendingToolsCalling,

        status: currentState.status,

        stepCount: currentState.stepCount,
        usage: currentState.usage,
      },
      // 可选的历史信息
      executionHistory: executionHistory?.slice(0, historyLimit),

      hasError: currentState.status === 'error',

      // 状态判断
      isActive: ['running', 'waiting_for_human_input'].includes(currentState.status),

      isCompleted: currentState.status === 'done',

      metadata: sessionMetadata,

      needsHumanInput: currentState.status === 'waiting_for_human_input',
      recentEvents: recentEvents?.slice(0, 10),
      sessionId,
      stats,
    });
  } catch (error: any) {
    console.error('Failed to get session status:', error);

    return NextResponse.json(
      {
        error: (error as Error).message,
      },
      { status: 500 },
    );
  }
}
//
// /**
//  * 更新会话配置
//  */
// export async function PATCH(request: NextRequest) {
//   try {
//     const { searchParams } = new URL(request.url);
//     const sessionId = searchParams.get('sessionId');
//
//     if (!sessionId) {
//       return NextResponse.json(
//         {
//           error: 'sessionId parameter is required',
//         },
//         { status: 400 },
//       );
//     }
//
//     const body = await request.json();
//     const { modelConfig, agentConfig, maxSteps, costLimit } = body;
//
//     // 1. 检查会话是否存在
//     const currentState = await stateManager.loadAgentState(sessionId);
//     if (!currentState) {
//       return NextResponse.json(
//         {
//           error: 'Session not found',
//         },
//         { status: 404 },
//       );
//     }
//
//     // 2. 检查会话是否可以更新（运行中的会话可能不允许某些更新）
//     if (currentState.status === 'running') {
//       // 只允许更新某些非关键配置
//       const allowedUpdates = { costLimit, maxSteps };
//       const hasDisallowedUpdates = modelConfig || agentConfig;
//
//       if (hasDisallowedUpdates) {
//         return NextResponse.json(
//           {
//             currentStatus: currentState.status,
//             error: 'Cannot update model or agent config while session is running',
//           },
//           { status: 409 },
//         );
//       }
//     }
//
//     // 3. 更新会话状态
//     const updatedState = { ...currentState };
//
//     if (maxSteps !== undefined) {
//       updatedState.maxSteps = maxSteps;
//     }
//
//     if (costLimit !== undefined) {
//       updatedState.costLimit = costLimit;
//     }
//
//     updatedState.lastModified = new Date().toISOString();
//
//     // 4. 保存更新后的状态
//     await stateManager.saveAgentState(sessionId, updatedState);
//
//     // 5. 更新元数据
//     const sessionMetadata = await stateManager.getSessionMetadata(sessionId);
//     if (sessionMetadata) {
//       const updatedMetadata = { ...sessionMetadata };
//
//       if (modelConfig) {
//         updatedMetadata.modelConfig = { ...updatedMetadata.modelConfig, ...modelConfig };
//       }
//
//       if (agentConfig) {
//         updatedMetadata.agentConfig = { ...updatedMetadata.agentConfig, ...agentConfig };
//       }
//
//       // 重新创建元数据（因为没有直接的更新方法）
//       await stateManager.createSessionMetadata(sessionId, {
//         agentConfig: updatedMetadata.agentConfig,
//         modelConfig: updatedMetadata.modelConfig,
//         userId: updatedMetadata.userId,
//       });
//     }
//
//     console.log(`[Agent Session] Updated configuration for session ${sessionId}`);
//
//     return NextResponse.json({
//       currentStatus: updatedState.status,
//       sessionId,
//       success: true,
//       updatedAt: updatedState.lastModified,
//     });
//   } catch (error: any) {
//     console.error(`[Agent Session] Failed to update session:`, error);
//
//     return NextResponse.json(
//       {
//         error: (error as Error).message,
//       },
//       { status: 500 },
//     );
//   }
// }
//
// /**
//  * 删除会话
//  */
// export async function DELETE(request: NextRequest) {
//   try {
//     const { searchParams } = new URL(request.url);
//     const sessionId = searchParams.get('sessionId');
//
//     if (!sessionId) {
//       return NextResponse.json(
//         {
//           error: 'sessionId parameter is required',
//         },
//         { status: 400 },
//       );
//     }
//
//     // 1. 检查会话是否存在
//     const currentState = await stateManager.loadAgentState(sessionId);
//     if (!currentState) {
//       return NextResponse.json(
//         {
//           error: 'Session not found',
//         },
//         { status: 404 },
//       );
//     }
//
//     // 2. 如果会话正在运行，先中断它
//     if (currentState.status === 'running') {
//       // 这里应该取消正在进行的任务
//       // 由于 QStash 不支持直接取消，我们标记会话为中断状态
//       const interruptedState = {
//         ...currentState,
//         interruption: {
//           canResume: false,
//           interruptedAt: new Date().toISOString(),
//           reason: 'Session deleted by user',
//         },
//         lastModified: new Date().toISOString(),
//         status: 'interrupted',
//       };
//
//       await stateManager.saveAgentState(sessionId, interruptedState);
//
//       // 发布中断事件
//       await streamManager.publishStreamEvent(sessionId, {
//         data: {
//           message: 'Session was deleted by user',
//           reason: 'session_deleted',
//         },
//         stepIndex: currentState.stepCount,
//         type: 'error',
//       });
//     }
//
//     // 3. 删除所有相关数据
//     await Promise.all([
//       stateManager.deleteAgentSession(sessionId),
//       streamManager.cleanupSession(sessionId),
//     ]);
//
//     console.log(`[Agent Session] Deleted session ${sessionId}`);
//
//     return NextResponse.json({
//       deletedAt: new Date().toISOString(),
//       sessionId,
//       success: true,
//     });
//   } catch (error: any) {
//     console.error(`[Agent Session] Failed to delete session:`, error);
//
//     return NextResponse.json(
//       {
//         error: (error as Error).message,
//       },
//       { status: 500 },
//     );
//   }
// }
