import { NextRequest, NextResponse } from 'next/server';
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
 * 处理人工干预请求
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      sessionId,
      action, // 'approve' | 'reject' | 'input' | 'select'
      data, // 具体的输入数据
      reason, // 操作原因（可选）
    } = body;

    if (!sessionId) {
      return NextResponse.json({
        error: 'sessionId is required',
      }, { status: 400 });
    }

    if (!action) {
      return NextResponse.json({
        error: 'action is required (approve, reject, input, select)',
      }, { status: 400 });
    }

    console.log(`[Human Intervention] Processing ${action} for session ${sessionId}`);

    // 1. 加载当前状态
    const currentState = await stateManager.loadAgentState(sessionId);

    if (!currentState) {
      return NextResponse.json({
        error: 'Session not found',
        sessionId,
      }, { status: 404 });
    }

    if (currentState.status !== 'waiting_for_human_input') {
      return NextResponse.json({
        error: 'Session is not waiting for human input',
        currentStatus: currentState.status,
        sessionId,
      }, { status: 409 });
    }

    // 2. 发布人工干预开始事件
    await streamManager.publishStreamEvent(sessionId, {
      type: 'step_start',
      stepIndex: currentState.stepCount,
      data: {
        phase: 'human_intervention',
        action,
        reason,
        timestamp: Date.now(),
      }
    });

    // 3. 根据操作类型构建参数
    let stepParams: any = {
      sessionId,
      stepIndex: currentState.stepCount,
      priority: 'high', // 人工干预后高优先级执行
    };

    switch (action) {
      case 'approve':
        if (!data?.approvedToolCall) {
          return NextResponse.json({
            error: 'approvedToolCall is required for approve action',
          }, { status: 400 });
        }

        if (!currentState.pendingToolsCalling) {
          return NextResponse.json({
            error: 'No pending tool calls to approve',
          }, { status: 409 });
        }

        // 验证批准的工具调用是否在待批准列表中
        const approvedTool = data.approvedToolCall;
        const pendingTool = currentState.pendingToolsCalling.find(
          (tool: any) => tool.id === approvedTool.id
        );

        if (!pendingTool) {
          return NextResponse.json({
            error: 'Approved tool call not found in pending list',
            approvedToolId: approvedTool.id,
          }, { status: 400 });
        }

        stepParams.approvedToolCall = approvedTool;
        break;

      case 'reject':
        if (!currentState.pendingToolsCalling) {
          return NextResponse.json({
            error: 'No pending tool calls to reject',
          }, { status: 409 });
        }

        stepParams.rejectionReason = reason || 'Tool call rejected by user';
        break;

      case 'input':
        if (!data?.input) {
          return NextResponse.json({
            error: 'input is required for input action',
          }, { status: 400 });
        }

        if (!currentState.pendingHumanPrompt) {
          return NextResponse.json({
            error: 'No pending human prompt to respond to',
          }, { status: 409 });
        }

        stepParams.humanInput = {
          prompt: currentState.pendingHumanPrompt.prompt,
          response: data.input,
          metadata: currentState.pendingHumanPrompt.metadata,
        };
        break;

      case 'select':
        if (!data?.selection) {
          return NextResponse.json({
            error: 'selection is required for select action',
          }, { status: 400 });
        }

        if (!currentState.pendingHumanSelect) {
          return NextResponse.json({
            error: 'No pending human selection to respond to',
          }, { status: 409 });
        }

        // 验证选择是否有效
        const selection = Array.isArray(data.selection) ? data.selection : [data.selection];
        const validOptions = currentState.pendingHumanSelect.options;
        const invalidSelections = selection.filter(
          (sel: any) => !validOptions.includes(sel)
        );

        if (invalidSelections.length > 0) {
          return NextResponse.json({
            error: 'Invalid selection options',
            invalidSelections,
            validOptions,
          }, { status: 400 });
        }

        stepParams.humanInput = {
          prompt: currentState.pendingHumanSelect.prompt,
          selection: currentState.pendingHumanSelect.multi ? selection : selection[0],
          options: validOptions,
          metadata: currentState.pendingHumanSelect.metadata,
        };
        break;

      default:
        return NextResponse.json({
          error: `Unknown action: ${action}. Supported actions: approve, reject, input, select`,
        }, { status: 400 });
    }

    // 4. 高优先级调度执行
    let messageId;
    try {
      messageId = await queueService.scheduleImmediateStep(stepParams);

      console.log(`[Human Intervention] Scheduled immediate execution for session ${sessionId} (messageId: ${messageId})`);
    } catch (error) {
      console.error(`[Human Intervention] Failed to schedule execution:`, error);

      // 发布错误事件
      await streamManager.publishStreamEvent(sessionId, {
        type: 'error',
        stepIndex: currentState.stepCount,
        data: {
          phase: 'human_intervention_scheduling',
          action,
          error: (error as Error).message,
        }
      });

      return NextResponse.json({
        error: 'Failed to schedule execution after human intervention',
        details: (error as Error).message,
        sessionId,
        action,
      }, { status: 500 });
    }

    // 5. 发布人工干预处理完成事件
    await streamManager.publishStreamEvent(sessionId, {
      type: 'step_complete',
      stepIndex: currentState.stepCount,
      data: {
        phase: 'human_intervention_processed',
        action,
        reason,
        scheduledMessageId: messageId,
        timestamp: Date.now(),
      }
    });

    return NextResponse.json({
      success: true,
      sessionId,
      action,
      message: `Human intervention processed successfully. Execution resumed.`,
      scheduledMessageId: messageId,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error(`[Human Intervention] Error processing intervention:`, error);

    return NextResponse.json({
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

/**
 * 获取待处理的人工干预列表
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const userId = searchParams.get('userId');

    if (!sessionId && !userId) {
      return NextResponse.json({
        error: 'Either sessionId or userId parameter is required',
      }, { status: 400 });
    }

    let sessions: string[] = [];

    if (sessionId) {
      sessions = [sessionId];
    } else if (userId) {
      // 获取用户的所有活跃会话
      const activeSessions = await stateManager.getActiveSessions();

      // 过滤出属于该用户的会话
      const userSessions = [];
      for (const session of activeSessions) {
        const metadata = await stateManager.getSessionMetadata(session);
        if (metadata?.userId === userId) {
          userSessions.push(session);
        }
      }
      sessions = userSessions;
    }

    // 检查每个会话的状态
    const pendingInterventions = [];

    for (const session of sessions) {
      const state = await stateManager.loadAgentState(session);
      const metadata = await stateManager.getSessionMetadata(session);

      if (state?.status === 'waiting_for_human_input') {
        const intervention: any = {
          sessionId: session,
          status: state.status,
          stepCount: state.stepCount,
          lastModified: state.lastModified,
          userId: metadata?.userId,
          modelConfig: metadata?.modelConfig,
        };

        // 添加具体的待处理内容
        if (state.pendingToolsCalling) {
          intervention.type = 'tool_approval';
          intervention.pendingToolsCalling = state.pendingToolsCalling;
        } else if (state.pendingHumanPrompt) {
          intervention.type = 'human_prompt';
          intervention.pendingHumanPrompt = state.pendingHumanPrompt;
        } else if (state.pendingHumanSelect) {
          intervention.type = 'human_select';
          intervention.pendingHumanSelect = state.pendingHumanSelect;
        }

        pendingInterventions.push(intervention);
      }
    }

    return NextResponse.json({
      pendingInterventions,
      totalCount: pendingInterventions.length,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error(`[Human Intervention] Error getting pending interventions:`, error);

    return NextResponse.json({
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
