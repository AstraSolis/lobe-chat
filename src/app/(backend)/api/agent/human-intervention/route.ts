import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';
import { AgentStateManager } from '@/server/modules/AgentRuntime/AgentStateManager';
import { StreamEventManager } from '@/server/modules/AgentRuntime/StreamEventManager';
import { QueueService } from '@/server/services/queue/QueueService';

const log = debug('agent:human-intervention');
// Initialize services
const stateManager = new AgentStateManager();
const streamManager = new StreamEventManager();

const queueService = new QueueService();

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

    log(`Processing ${action} for session ${sessionId}`);

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
        currentStatus: currentState.status,
        error: 'Session is not waiting for human input',
        sessionId,
      }, { status: 409 });
    }

    // 2. 发布人工干预开始事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        action,
        phase: 'human_intervention',
        reason,
        timestamp: Date.now(),
      },
      stepIndex: currentState.stepCount,
      type: 'step_start'
    });

    // 3. 根据操作类型构建参数
    let stepParams: any = {
      priority: 'high',
      sessionId,
      stepIndex: currentState.stepCount, // 人工干预后高优先级执行
    };

    switch (action) {
      case 'approve': {
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
            approvedToolId: approvedTool.id,
            error: 'Approved tool call not found in pending list',
          }, { status: 400 });
        }

        stepParams.approvedToolCall = approvedTool;
        break;
      }

      case 'reject': {
        if (!currentState.pendingToolsCalling) {
          return NextResponse.json({
            error: 'No pending tool calls to reject',
          }, { status: 409 });
        }

        stepParams.rejectionReason = reason || 'Tool call rejected by user';
        break;
      }

      case 'input': {
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
          metadata: currentState.pendingHumanPrompt.metadata,
          prompt: currentState.pendingHumanPrompt.prompt,
          response: data.input,
        };
        break;
      }

      case 'select': {
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
          metadata: currentState.pendingHumanSelect.metadata,
          options: validOptions,
          prompt: currentState.pendingHumanSelect.prompt,
          selection: currentState.pendingHumanSelect.multi ? selection : selection[0],
        };
        break;
      }

      default: {
        return NextResponse.json({
          error: `Unknown action: ${action}. Supported actions: approve, reject, input, select`,
        }, { status: 400 });
      }
    }

    // 4. 高优先级调度执行
    let messageId;
    try {
      messageId = await queueService.scheduleImmediateStep(stepParams);

      log(`Scheduled immediate execution for session ${sessionId} (messageId: ${messageId})`);
    } catch (error) {
      console.error(`[Human Intervention] Failed to schedule execution:`, error);

      // 发布错误事件
      await streamManager.publishStreamEvent(sessionId, {
        data: {
          action,
          error: (error as Error).message,
          phase: 'human_intervention_scheduling',
        },
        stepIndex: currentState.stepCount,
        type: 'error'
      });

      return NextResponse.json({
        action,
        details: (error as Error).message,
        error: 'Failed to schedule execution after human intervention',
        sessionId,
      }, { status: 500 });
    }

    // 5. 发布人工干预处理完成事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        action,
        phase: 'human_intervention_processed',
        reason,
        scheduledMessageId: messageId,
        timestamp: Date.now(),
      },
      stepIndex: currentState.stepCount,
      type: 'step_complete'
    });

    return NextResponse.json({
      action,
      message: `Human intervention processed successfully. Execution resumed.`,
      scheduledMessageId: messageId,
      sessionId,
      success: true,
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
          lastModified: state.lastModified,
          modelConfig: metadata?.modelConfig,
          sessionId: session,
          status: state.status,
          stepCount: state.stepCount,
          userId: metadata?.userId,
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
      timestamp: new Date().toISOString(),
      totalCount: pendingInterventions.length,
    });

  } catch (error: any) {
    console.error(`[Human Intervention] Error getting pending interventions:`, error);

    return NextResponse.json({
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}
