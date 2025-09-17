import { AgentEvent, AgentInstruction, InstructionExecutor } from '@lobechat/agent-runtime';
import { ClientSecretPayload } from '@lobechat/types';
import debug from 'debug';

import { initModelRuntimeWithUserPayload } from '../ModelRuntime';
import { StreamEventManager } from './StreamEventManager';

const log = debug('lobe-server:agent-runtime:streaming-executors');

interface StreamingExecutorContext {
  fileService?: any;
  messageModel?: any;
  sessionId: string;
  stepIndex: number;
  streamManager: StreamEventManager;
  userId?: string;
  userPayload?: ClientSecretPayload;
}

/**
 * 创建流式 LLM 执行器
 * 集成 Agent Runtime 和流式事件发布
 */
export function createStreamingLLMExecutor(ctx: StreamingExecutorContext): InstructionExecutor {
  return async (instruction, state) => {
    const { payload } = instruction as Extract<AgentInstruction, { type: 'call_llm' }>;
    const { sessionId, stepIndex, streamManager } = ctx;
    const events: AgentEvent[] = [];

    // 类型断言确保 payload 的正确性
    const llmPayload = payload as {
      [key: string]: any;
      assistantMessageId?: string;
      messages: any[];
      model: string;
      provider: string;
    };

    log('Starting LLM execution for session %s:%d', sessionId, stepIndex);

    // 发布流式开始事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        messageId: llmPayload.assistantMessageId || 'unknown',
        model: llmPayload.model,
        provider: llmPayload.provider,
        sessionId,
      },
      stepIndex,
      type: 'stream_start',
    });

    try {
      let content = '';
      let toolCalls: any[] = [];
      let thinkingContent = '';
      let imageList: any[] = [];
      let grounding: any = null;

      // 初始化 ModelRuntime
      const modelRuntime = await initModelRuntimeWithUserPayload(
        llmPayload.provider,
        ctx.userPayload || {},
      );

      // 直接使用 ModelRuntime 进行流式处理
      const stream = modelRuntime.chat({
        messages: llmPayload.messages,
        model: llmPayload.model,
        stream: true,
        temperature: llmPayload.temperature || 0.7,
      });

      // 处理流式响应
      const response = await stream;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No readable stream available');

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 解析 SSE 数据
          const chunk = JSON.parse(new TextDecoder().decode(value));
          if (!chunk) continue;
          // 处理不同类型的流式内容
          if (chunk.type === 'text' && chunk.text) {
            content += chunk.text;

            // 立即发布流式内容到 Redis Stream
            await streamManager.publishStreamChunk(sessionId, stepIndex, {
              chunkType: 'text',
              content: chunk.text,
              fullContent: content,
              messageId: llmPayload.assistantMessageId || 'unknown',
            });

            // 实时更新数据库中的消息内容
            if (ctx.messageModel && llmPayload.assistantMessageId) {
              try {
                await ctx.messageModel.updateContent(llmPayload.assistantMessageId, content);
              } catch (error) {
                log('[StreamingLLMExecutor] Failed to update message content: %O', error);
              }
            }
          } else if (chunk.type === 'tool_calls' && chunk.tool_calls) {
            toolCalls = chunk.tool_calls;

            await streamManager.publishStreamChunk(sessionId, stepIndex, {
              chunkType: 'tool_calls',
              messageId: llmPayload.assistantMessageId || 'unknown',
              toolCalls: toolCalls,
            });
          }

          // 构建标准 Agent Runtime 事件
          events.push({ chunk, type: 'llm_stream' });
        }
      } finally {
        reader.releaseLock();
      }

      // 发布流式结束事件
      await streamManager.publishStreamEvent(sessionId, {
        data: {
          finalContent: content,
          grounding: grounding,
          imageList: imageList.length > 0 ? imageList : undefined,
          messageId: llmPayload.assistantMessageId || 'unknown',
          reasoning: thinkingContent || undefined,
          toolCalls: toolCalls,
        },
        stepIndex,
        type: 'stream_end',
      });

      log('LLM execution completed for session %s:%d', sessionId, stepIndex);

      // 最终更新数据库
      if (ctx.messageModel && llmPayload.assistantMessageId) {
        try {
          await ctx.messageModel.updateMessage(llmPayload.assistantMessageId, {
            content,
            imageList: imageList.length > 0 ? imageList : undefined,
            reasoning: thinkingContent || undefined,
            search: grounding,
            status: 'completed',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        } catch (error) {
          log('[StreamingLLMExecutor] Failed to update final message: %O', error);
        }
      }

      // 更新 Agent 状态
      const newState = structuredClone(state);
      newState.messages.push({
        content,
        role: 'assistant',
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      events.push({
        result: { content, tool_calls: toolCalls },
        type: 'llm_result',
      });

      return {
        events,
        newState,
        nextContext: {
          payload: {
            hasToolCalls: toolCalls.length > 0,
            result: { content, tool_calls: toolCalls },
            toolCalls,
          },
          phase: 'llm_result',
          session: {
            eventCount: newState.events.length + events.length,
            messageCount: newState.messages.length,
            sessionId: state.sessionId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        },
      };
    } catch (error) {
      // 发布错误事件
      await streamManager.publishStreamEvent(sessionId, {
        data: {
          error: (error as Error).message,
          messageId: llmPayload.assistantMessageId || 'unknown',
          phase: 'llm_execution',
        },
        stepIndex,
        type: 'error',
      });

      console.error(
        `[StreamingLLMExecutor] LLM execution failed for session ${sessionId}:${stepIndex}:`,
        error,
      );
      throw error;
    }
  };
}

/**
 * 创建流式工具执行器
 */
export function createStreamingToolExecutor(ctx: StreamingExecutorContext): InstructionExecutor {
  return async (instruction, state) => {
    const { toolCall } = instruction as Extract<AgentInstruction, { type: 'call_tool' }>;
    const { sessionId, stepIndex, streamManager } = ctx;
    const events: AgentEvent[] = [];

    log('Executing tool %s for session %s:%d', toolCall.function.name, sessionId, stepIndex);

    // 发布工具执行开始事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        phase: 'tool_execution',
        toolCall,
        toolName: toolCall.function.name,
      },
      stepIndex,
      type: 'step_start',
    });

    try {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const startTime = Date.now();

      // Mock 工具执行结果
      const result = {
        args,
        message: `Mock execution of tool ${toolCall.function.name} with args: ${JSON.stringify(args)}`,
        success: true,
        toolName: toolCall.function.name,
      };

      // 模拟执行时间
      await new Promise((resolve) => {
        setTimeout(resolve, Math.random() * 500 + 100);
      });
      const executionTime = Date.now() - startTime;

      // 发布工具执行结果事件
      await streamManager.publishStreamEvent(sessionId, {
        data: {
          executionTime,
          phase: 'tool_execution',
          result,
          toolCall,
        },
        stepIndex,
        type: 'step_complete',
      });

      const newState = structuredClone(state);
      newState.messages.push({
        content: typeof result === 'string' ? result : JSON.stringify(result),
        role: 'tool',
        tool_call_id: toolCall.id,
      });

      events.push({
        id: toolCall.id,
        result,
        type: 'tool_result',
      });

      log('Tool execution completed for session %s:%d (%dms)', sessionId, stepIndex, executionTime);

      return {
        events,
        newState,
        nextContext: {
          payload: {
            executionTime,
            result,
            toolCall,
            toolCallId: toolCall.id,
          },
          phase: 'tool_result',
          session: {
            eventCount: newState.events.length + events.length,
            messageCount: newState.messages.length,
            sessionId: state.sessionId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        },
      };
    } catch (error) {
      // 发布工具执行错误事件
      await streamManager.publishStreamEvent(sessionId, {
        data: {
          error: (error as Error).message,
          phase: 'tool_execution',
          toolCall,
        },
        stepIndex,
        type: 'error',
      });

      events.push({
        error: error,
        type: 'error',
      });

      console.error(
        `[StreamingToolExecutor] Tool execution failed for session ${sessionId}:${stepIndex}:`,
        error,
      );

      return {
        events,
        newState: state, // 状态不变
      };
    }
  };
}

/**
 * 创建流式人工审批执行器
 */
export function createStreamingHumanApprovalExecutor(
  ctx: StreamingExecutorContext,
): InstructionExecutor {
  return async (instruction, state) => {
    const { pendingToolsCalling } = instruction as Extract<
      AgentInstruction,
      { type: 'request_human_approve' }
    >;
    const { sessionId, stepIndex, streamManager } = ctx;

    log('Requesting human approval for session %s:%d', sessionId, stepIndex);

    // 发布人工审批请求事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        pendingToolsCalling,
        phase: 'human_approval',
        requiresApproval: true,
      },
      stepIndex,
      type: 'step_start',
    });

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'waiting_for_human_input';
    newState.pendingToolsCalling = pendingToolsCalling;

    // 通过流式系统通知前端显示审批 UI
    await streamManager.publishStreamChunk(sessionId, stepIndex, {
      // 使用 sessionId 作为 messageId
      chunkType: 'tool_calls',
      messageId: ctx.sessionId,
      toolCalls: pendingToolsCalling,
    });

    const events: AgentEvent[] = [
      {
        pendingToolsCalling,
        sessionId: newState.sessionId,
        type: 'human_approve_required',
      },
      {
        toolCalls: pendingToolsCalling,
        type: 'tool_pending',
      },
    ];

    log('Human approval requested for session %s:%d', sessionId, stepIndex);

    return {
      events,
      newState,
      // 不提供 nextContext，因为需要等待人工干预
    };
  };
}

/**
 * 创建流式完成执行器
 */
export function createStreamingFinishExecutor(ctx: StreamingExecutorContext): InstructionExecutor {
  return async (instruction, state) => {
    const { reason, reasonDetail } = instruction as Extract<AgentInstruction, { type: 'finish' }>;
    const { sessionId, stepIndex, streamManager } = ctx;

    log('Finishing execution for session %s:%d (%s)', sessionId, stepIndex, reason);

    // 发布执行完成事件
    await streamManager.publishStreamEvent(sessionId, {
      data: {
        finalState: { ...state, status: 'done' },
        phase: 'execution_complete',
        reason,
        reasonDetail,
      },
      stepIndex,
      type: 'step_complete',
    });

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'done';

    const events: AgentEvent[] = [
      {
        finalState: newState,
        reason,
        reasonDetail,
        type: 'done',
      },
    ];

    return { events, newState };
  };
}
