import { NextRequest, NextResponse } from 'next/server';
import { StreamEventManager } from '@/server/services/agent/StreamEventManager';

// 初始化流式事件管理器
const streamManager = new StreamEventManager({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  password: process.env.REDIS_PASSWORD,
  db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : 0,
});

/**
 * Server-Sent Events (SSE) 端点
 * 为客户端提供实时的 Agent 执行事件流
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const lastEventId = searchParams.get('lastEventId') || '0';
  const includeHistory = searchParams.get('includeHistory') === 'true';

  if (!sessionId) {
    return NextResponse.json({
      error: 'sessionId parameter is required'
    }, { status: 400 });
  }

  console.log(`[Agent Stream] Starting SSE connection for session ${sessionId} from eventId ${lastEventId}`);

  // 创建 Server-Sent Events 流
  const stream = new ReadableStream({
    start(controller) {
      // 发送连接确认事件
      const connectEvent = {
        type: 'connected',
        sessionId,
        timestamp: Date.now(),
        lastEventId,
      };

      controller.enqueue(`data: ${JSON.stringify(connectEvent)}\n\n`);
      console.log(`[Agent Stream] SSE connection established for session ${sessionId}`);

      // 如果需要，先发送历史事件
      if (includeHistory) {
        streamManager.getStreamHistory(sessionId, 50).then(history => {
          // 按时间顺序发送历史事件（最早的在前面）
          const sortedHistory = history.reverse();

          sortedHistory.forEach(event => {
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
            console.log(`[Agent Stream] Sent ${sortedHistory.length} historical events for session ${sessionId}`);
          }
        }).catch(error => {
          console.error('[Agent Stream] Failed to load history:', error);

          const errorEvent = {
            type: 'error',
            sessionId,
            timestamp: Date.now(),
            data: {
              phase: 'history_loading',
              error: error.message,
            }
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
              events.forEach(event => {
                try {
                  // 添加 SSE 特定的字段
                  const sseEvent = {
                    ...event,
                    timestamp: event.timestamp || Date.now(),
                    sessionId,
                  };

                  controller.enqueue(`data: ${JSON.stringify(sseEvent)}\n\n`);
                } catch (error) {
                  console.error('[Agent Stream] Error sending event:', error);
                }
              });
            },
            abortController.signal
          );
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error('[Agent Stream] Subscription error:', error);

            const errorEvent = {
              type: 'error',
              sessionId,
              timestamp: Date.now(),
              data: {
                phase: 'stream_subscription',
                error: (error as Error).message,
              }
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
            type: 'heartbeat',
            sessionId,
            timestamp: Date.now(),
          };

          controller.enqueue(`data: ${JSON.stringify(heartbeat)}\n\n`);
        } catch (error) {
          console.error('[Agent Stream] Heartbeat error:', error);
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      // 清理函数
      const cleanup = () => {
        abortController.abort();
        clearInterval(heartbeatInterval);
        console.log(`[Agent Stream] SSE connection closed for session ${sessionId}`);
      };

      // 监听连接关闭
      request.signal?.addEventListener('abort', cleanup);

      // 存储清理函数以便在 cancel 时调用
      (controller as any)._cleanup = cleanup;
    },

    cancel(reason) {
      console.log(`[Agent Stream] SSE connection cancelled for session ${sessionId}:`, reason);

      // 调用清理函数
      if ((this as any)._cleanup) {
        (this as any)._cleanup();
      }
    }
  });

  // 设置 SSE 响应头
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    },
  });
}

/**
 * OPTIONS 请求处理（CORS 预检）
 */
export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
      'Access-Control-Max-Age': '86400',
    },
  });
}
