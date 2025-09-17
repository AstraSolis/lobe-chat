import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { AgentRuntimeService } from '@/server/services/agentRuntime';

import { isEnableAgent } from '../isEnableAgent';

const log = debug('api-route:agent:start');

// Initialize service
const agentRuntimeService = new AgentRuntimeService();

/**
 * 启动 Agent 会话执行
 */
export async function POST(request: NextRequest) {
  if (!isEnableAgent()) {
    return NextResponse.json({ error: 'Agent features are not enabled' }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { sessionId, context, priority = 'normal', delay = 1000 } = body;

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    log('Starting execution for session %s', sessionId);

    // 使用 AgentRuntimeService 启动执行
    const result = await agentRuntimeService.startExecution({
      context,
      delay,
      priority,
      sessionId,
    });

    return NextResponse.json({
      ...result,
      message: 'Agent execution started successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    log('Failed to start execution: %O', error);

    return NextResponse.json(
      {
        error: error.message,
        success: false,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

/**
 * 健康检查端点
 */
export async function GET() {
  if (!isEnableAgent()) {
    return NextResponse.json({ error: 'Agent features are not enabled' }, { status: 404 });
  }

  try {
    return NextResponse.json({
      healthy: true,
      message: 'Agent start service is running',
      timestamp: new Date().toISOString(),
    });
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
