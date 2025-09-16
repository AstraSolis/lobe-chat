import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { StreamEventManager } from '@/server/modules/AgentRuntime/StreamEventManager';

const log = debug('agent:stream');

// Initialize stream event manager
const streamManager = new StreamEventManager();

/**
 * Server-Sent Events (SSE) endpoint
 * Provides real-time Agent execution event stream for clients
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const lastEventId = searchParams.get('lastEventId') || '0';
  const includeHistory = searchParams.get('includeHistory') === 'true';

  if (!sessionId) {
    return NextResponse.json(
      {
        error: 'sessionId parameter is required',
      },
      { status: 400 },
    );
  }

  log(`Starting SSE connection for session ${sessionId} from eventId ${lastEventId}`);

  // 创建 Server-Sent Events 流
  const stream = new ReadableStream({
    cancel(reason) {
      log(`SSE connection cancelled for session ${sessionId}:`, reason);

      // Call cleanup function
      if ((this as any)._cleanup) {
        (this as any)._cleanup();
      }
    },

    start(controller) {
      // 发送连接确认事件
      const connectEvent = {
        lastEventId,
        sessionId,
        timestamp: Date.now(),
        type: 'connected',
      };

      controller.enqueue(`data: ${JSON.stringify(connectEvent)}\n\n`);
      log(`SSE connection established for session ${sessionId}`);

      // 如果需要，先发送历史事件
      if (includeHistory) {
        streamManager
          .getStreamHistory(sessionId, 50)
          .then((history) => {
            // 按时间顺序发送历史事件（最早的在前面）
            const sortedHistory = history.reverse();

            sortedHistory.forEach((event) => {
              // 只发送比 lastEventId 更新的事件
              if (!lastEventId || lastEventId === '0' || event.timestamp.toString() > lastEventId) {
                try {
                  controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
                } catch (error) {
                  console.error('[Agent Stream] Error sending history event:', error);
                }
              }
            });

            if (sortedHistory.length > 0) {
              log(`Sent ${sortedHistory.length} historical events for session ${sessionId}`);
            }
          })
          .catch((error) => {
            console.error('[Agent Stream] Failed to load history:', error);

            const errorEvent = {
              data: {
                error: error.message,
                phase: 'history_loading',
              },
              sessionId,
              timestamp: Date.now(),
              type: 'error',
            };

            try {
              controller.enqueue(`data: ${JSON.stringify(errorEvent)}\n\n`);
            } catch (controllerError) {
              console.error('[Agent Stream] Failed to send error event:', controllerError);
            }
          });
      }

      // 创建 AbortController 用于取消订阅
      const abortController = new AbortController();

      // 订阅新的流式事件
      const subscribeToEvents = async () => {
        try {
          await streamManager.subscribeStreamEvents(
            sessionId,
            lastEventId,
            (events) => {
              events.forEach((event) => {
                try {
                  // 添加 SSE 特定的字段
                  const sseEvent = {
                    ...event,
                    sessionId,
                    timestamp: event.timestamp || Date.now(),
                  };

                  controller.enqueue(`data: ${JSON.stringify(sseEvent)}\n\n`);
                } catch (error) {
                  console.error('[Agent Stream] Error sending event:', error);
                }
              });
            },
            abortController.signal,
          );
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error('[Agent Stream] Subscription error:', error);

            const errorEvent = {
              data: {
                error: (error as Error).message,
                phase: 'stream_subscription',
              },
              sessionId,
              timestamp: Date.now(),
              type: 'error',
            };

            try {
              controller.enqueue(`data: ${JSON.stringify(errorEvent)}\n\n`);
            } catch (controllerError) {
              console.error('[Agent Stream] Failed to send subscription error:', controllerError);
            }
          }
        }
      };

      // 开始订阅
      subscribeToEvents();

      // 定期发送心跳（每 30 秒）
      const heartbeatInterval = setInterval(() => {
        try {
          const heartbeat = {
            sessionId,
            timestamp: Date.now(),
            type: 'heartbeat',
          };

          controller.enqueue(`data: ${JSON.stringify(heartbeat)}\n\n`);
        } catch (error) {
          console.error('[Agent Stream] Heartbeat error:', error);
          clearInterval(heartbeatInterval);
        }
      }, 30_000);

      // Cleanup function
      const cleanup = () => {
        abortController.abort();
        clearInterval(heartbeatInterval);
        log(`SSE connection closed for session ${sessionId}`);
      };

      // 监听连接关闭
      request.signal?.addEventListener('abort', cleanup);

      // 存储清理函数以便在 cancel 时调用
      (controller as any)._cleanup = cleanup;
    },
  });

  // 设置 SSE 响应头
  return new Response(stream, {
    headers: {
      'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    },
  });
}

/**
 * OPTIONS request handler (CORS preflight)
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Max-Age': '86400',
    },
    status: 200,
  });
}
