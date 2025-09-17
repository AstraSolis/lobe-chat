import { isDesktop } from '@lobechat/const';
import { produce } from 'immer';
import { StateCreator } from 'zustand/vanilla';

import { StreamEvent, agentClientService } from '@/services/agent/client';
import { messageService } from '@/services/message';
import { getAgentStoreState } from '@/store/agent';
import { agentChatConfigSelectors, agentSelectors } from '@/store/agent/slices/chat';
import { ChatStore } from '@/store/chat/store';
import { CreateMessageParams, SendMessageParams } from '@/types/message';
import { setNamespace } from '@/utils/storeDebug';

const n = setNamespace('agent');

export interface AgentAction {
  internal_cleanupAgentSession: (assistantId: string) => void;
  internal_handleAgentError: (assistantId: string, error: string) => void;
  /**
   * Agent Runtime 相关方法
   */
  internal_handleAgentStreamEvent: (assistantId: string, event: StreamEvent) => Promise<void>;
  internal_handleHumanIntervention: (
    assistantId: string,
    action: string,
    data?: any,
  ) => Promise<void>;
  /**
   * Sends a message through the agent runtime workflow
   */
  sendAgentMessage: (params: SendMessageParams) => Promise<void>;
}

export const agentSlice: StateCreator<ChatStore, [['zustand/devtools', never]], [], AgentAction> = (
  set,
  get,
) => ({
  internal_cleanupAgentSession: (assistantId: string) => {
    const session = get().agentSessions[assistantId];
    if (!session) return;

    console.log(`[Agent Runtime] Cleaning up agent session for ${assistantId}`);

    // 关闭 EventSource 连接
    if (session.eventSource) {
      session.eventSource.close();
    }

    // 删除会话信息
    set(
      produce((draft) => {
        delete draft.agentSessions[assistantId];
      }),
      false,
      n('cleanupAgentSession', { assistantId }),
    );

    // 如果有错误，删除服务端会话
    if (session.sessionId && session.status === 'error') {
      agentClientService.deleteSession(session.sessionId).catch((error: Error) => {
        console.warn(
          `[Agent Runtime] Failed to delete server session ${session.sessionId}:`,
          error,
        );
      });
    }
  },

  internal_handleAgentError: (assistantId: string, errorMessage: string) => {
    console.error(`[Agent Runtime] Agent error for ${assistantId}: ${errorMessage}`);

    // 更新会话错误状态
    set(
      produce((draft) => {
        if (draft.agentSessions[assistantId]) {
          draft.agentSessions[assistantId].status = 'error';
          draft.agentSessions[assistantId].error = errorMessage;
        }
      }),
      false,
      n('setAgentError', { assistantId, errorMessage }),
    );

    // 更新消息错误状态
    messageService.updateMessageError(assistantId, {
      message: errorMessage,
      type: 'UnknownError' as any,
    });
    get().refreshMessages();

    // 停止 loading 状态
    get().internal_toggleChatLoading(false, assistantId);

    // 清理会话
    get().internal_cleanupAgentSession(assistantId);
  },

  // ======== Agent Runtime 相关方法 ========
  internal_handleAgentStreamEvent: async (assistantId: string, event: StreamEvent) => {
    const session = get().agentSessions[assistantId];
    if (!session) return;

    console.log(`[Agent Runtime] Handling event ${event.type} for ${assistantId}:`, event);

    // 更新会话状态
    set(
      produce((draft) => {
        if (draft.agentSessions[assistantId]) {
          draft.agentSessions[assistantId].lastEventId = event.timestamp.toString();
          if (event.stepIndex !== undefined) {
            draft.agentSessions[assistantId].stepCount = event.stepIndex;
          }
        }
      }),
      false,
      n('updateAgentSessionFromEvent', { assistantId, eventType: event.type }),
    );

    switch (event.type) {
      case 'connected': {
        console.log(`[Agent Runtime] Agent stream connected for ${assistantId}`);
        break;
      }

      case 'step_start': {
        // 步骤开始事件
        break;
      }

      case 'step_complete': {
        const { status, hasNextContext } = event.data || {};

        // 更新状态
        set(
          produce((draft) => {
            if (draft.agentSessions[assistantId]) {
              draft.agentSessions[assistantId].status = status;
            }
          }),
          false,
          n('updateAgentStatus', { assistantId, status }),
        );

        // 如果步骤完成且没有下一个上下文，可能需要特殊处理
        if (status === 'done' && !hasNextContext) {
          get().internal_toggleChatLoading(false, assistantId);
          // 可能需要显示桌面通知等
          if (isDesktop) {
            try {
              const { desktopNotificationService } = await import(
                '@/services/electron/desktopNotification'
              );
              await desktopNotificationService.showNotification({
                body: 'AI 回复生成完成',
                title: 'AI 回复完成', // TODO: 使用 i18n
              });
            } catch (error) {
              console.error('Desktop notification error:', error);
            }
          }
        }
        break;
      }

      case 'llm_stream_chunk': {
        // LLM 流式输出
        const { content, chunk } = event.data || {};
        if (content || chunk) {
          await get().internal_updateMessageContent(assistantId, content || chunk);
        }
        break;
      }

      case 'llm_stream_complete': {
        // LLM 流式完成
        const { content, usage, toolCalls } = event.data || {};
        if (toolCalls && toolCalls.length > 0) {
          // 更新工具调用
          await get().internal_updateMessageContent(assistantId, content || '', {
            metadata: usage,
            toolCalls,
          });
        }
        break;
      }

      case 'tool_start': {
        const { toolCall } = event.data || {};
        console.log(`[Agent Runtime] Tool call started: ${toolCall?.function?.name}`);
        break;
      }

      case 'tool_complete': {
        const { toolCall } = event.data || {};
        console.log(`[Agent Runtime] Tool call completed: ${toolCall?.function?.name}`);
        // 刷新消息以显示工具结果
        await get().refreshMessages();
        break;
      }

      case 'human_approval_request': {
        // 需要人工批准
        const { pendingToolsCalling } = event.data || {};
        set(
          produce((draft) => {
            if (draft.agentSessions[assistantId]) {
              draft.agentSessions[assistantId].needsHumanInput = true;
              draft.agentSessions[assistantId].pendingApproval = pendingToolsCalling;
            }
          }),
          false,
          n('setHumanApprovalNeeded', { assistantId }),
        );

        // 停止 loading 状态，等待人工干预
        get().internal_toggleChatLoading(false, assistantId);
        break;
      }

      case 'error': {
        const { error, message } = event.data || {};
        console.error(`[Agent Runtime] Error in agent execution:`, error);
        get().internal_handleAgentError(assistantId, message || error || 'Unknown agent error');
        break;
      }

      case 'heartbeat': {
        // 心跳事件，保持连接活跃
        break;
      }

      default: {
        console.log(`[Agent Runtime] Unknown event type: ${event.type}`);
        break;
      }
    }
  },

  internal_handleHumanIntervention: async (assistantId: string, action: string, data?: any) => {
    const session = get().agentSessions[assistantId];
    if (!session || !session.needsHumanInput) {
      console.warn(`[Agent Runtime] No human intervention needed for ${assistantId}`);
      return;
    }

    try {
      console.log(`[Agent Runtime] Handling human intervention ${action} for ${assistantId}`);

      // 发送人工干预请求
      await agentClientService.handleHumanIntervention({
        action: action as any,
        data,
        sessionId: session.sessionId,
      });

      // 重新开始 loading 状态
      get().internal_toggleChatLoading(true, assistantId);

      // 清除人工干预状态
      set(
        produce((draft) => {
          if (draft.agentSessions[assistantId]) {
            draft.agentSessions[assistantId].needsHumanInput = false;
            draft.agentSessions[assistantId].pendingApproval = undefined;
            draft.agentSessions[assistantId].pendingPrompt = undefined;
            draft.agentSessions[assistantId].pendingSelect = undefined;
          }
        }),
        false,
        n('clearHumanIntervention', { action, assistantId }),
      );

      console.log(`[Agent Runtime] Human intervention ${action} processed for ${assistantId}`);
    } catch (error) {
      console.error(`[Agent Runtime] Failed to handle human intervention:`, error);
      get().internal_handleAgentError(
        assistantId,
        `Human intervention failed: ${(error as Error).message}`,
      );
    }
  },

  sendAgentMessage: async ({
    message,
    files,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isWelcomeQuestion: _isWelcomeQuestion,
  }: SendMessageParams) => {
    const { activeTopicId, activeId, activeThreadId } = get();
    if (!activeId) return;

    const { createAgentWorkflowContext } = await import('@/services/agentRuntime');

    set({ isCreatingMessage: true }, false, n('creatingMessage/start(agent)'));

    const fileIdList = files?.map((f: any) => f.id);

    // First add the user message
    const newMessage: CreateMessageParams = {
      content: message,
      files: fileIdList,
      role: 'user',
      sessionId: activeId,
      threadId: activeThreadId,
      topicId: activeTopicId,
    };

    const userMessageId = get().internal_createTmpMessage(newMessage);

    // Create message in server (for persistence)
    try {
      await get().internal_createMessage(newMessage, { tempMessageId: userMessageId });
    } catch (error) {
      console.error('Failed to create user message:', error);
      get().internal_dispatchMessage({ id: userMessageId, type: 'deleteMessage' });
      set({ isCreatingMessage: false }, false, n('creatingMessage/error'));
      return;
    }

    set({ isCreatingMessage: false }, false, n('creatingMessage/end'));

    // Create agent workflow context
    createAgentWorkflowContext(message, fileIdList);

    // Create a placeholder AI message for the agent response
    const agentMessageId = get().internal_createTmpMessage({
      content: 'Processing your request through agent workflow...',
      role: 'assistant',
      sessionId: activeId,
      threadId: activeThreadId,
      topicId: activeTopicId,
    });

    // Start durable agent runtime processing
    try {
      set({ isCreatingMessage: true }, false, n('agentWorkflow/start'));
      get().internal_toggleChatLoading(true, agentMessageId, n('sendAgentMessage/start') as string);

      // 创建 Agent 会话
      const agentStoreState = getAgentStoreState();
      const agentConfig = agentSelectors.currentAgentConfig(agentStoreState);
      const agentChatConfig = agentChatConfigSelectors.currentChatConfig(agentStoreState);
      const { provider } = agentConfig;

      const sessionResponse = await agentClientService.createSession({
        agentConfig: {
          // costLimit: agentChatConfig.costLimit,
          // enableRAG: false,
          // TODO: 基于消息内容判断
          enableSearch: agentChatConfigSelectors.isAgentEnableSearch(agentStoreState),
          // humanApprovalRequired: agentChatConfig.humanApprovalRequired || false,
          maxSteps: 50,
          ...agentChatConfig,
        },

        autoStart: true,

        messages: [
          {
            content: message,
            role: 'user',
          },
        ],
        // 使用当前 sessionId 作为 userId
        modelConfig: {
          provider: provider!,
          ...agentConfig,
        },
        userId: activeId,
      });

      console.log(
        `[Agent Runtime] Created session ${sessionResponse.sessionId} for message ${agentMessageId}`,
      );

      // 存储 Agent 会话信息
      set(
        produce((draft) => {
          draft.agentSessions[agentMessageId] = {
            lastEventId: '0',
            sessionId: sessionResponse.sessionId,
            status: sessionResponse.initialState.status,
            stepCount: 0,
            totalCost: 0,
          };
        }),
        false,
        n('createAgentSession', {
          assistantId: agentMessageId,
          sessionId: sessionResponse.sessionId,
        }),
      );

      // 创建流式连接
      const eventSource = agentClientService.createStreamConnection(sessionResponse.sessionId, {
        includeHistory: true,
        onConnect: () => {
          console.log(`[Agent Runtime] Stream connected for ${agentMessageId}`);
        },
        onDisconnect: () => {
          console.log(`[Agent Runtime] Stream disconnected for ${agentMessageId}`);
          get().internal_cleanupAgentSession(agentMessageId);
        },
        onError: (error: Error) => {
          console.error(`[Agent Runtime] Stream error for ${agentMessageId}:`, error);
          get().internal_handleAgentError(agentMessageId, error.message);
        },
        onEvent: async (event: StreamEvent) => {
          await get().internal_handleAgentStreamEvent(agentMessageId, event);
        },
      });

      // 保存 EventSource 引用
      set(
        produce((draft) => {
          if (draft.agentSessions[agentMessageId]) {
            draft.agentSessions[agentMessageId].eventSource = eventSource;
          }
        }),
        false,
        n('saveAgentEventSource', { assistantId: agentMessageId }),
      );
    } catch (error) {
      console.error(`[Agent Runtime] Failed to start agent session for ${agentMessageId}:`, error);

      // 更新错误状态
      await messageService.updateMessageError(agentMessageId, {
        message: (error as Error).message,
        type: 'UnknownError' as any,
      });
      await get().refreshMessages();

      get().internal_toggleChatLoading(
        false,
        agentMessageId,
        n('generateMessage(error)', { error, messageId: agentMessageId }),
      );

      throw error;
    } finally {
      set({ isCreatingMessage: false }, false, n('agentWorkflow/end'));
    }
  },
});
