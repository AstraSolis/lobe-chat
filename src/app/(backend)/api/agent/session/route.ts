import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { AgentRuntimeService } from '@/server/services/agentRuntime';

const log = debug('agent:session');

// Initialize service
const agentRuntimeService = new AgentRuntimeService();

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
      autoStart = true,
    } = body;

    // 生成会话 ID
    const sessionId =
      providedSessionId || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    log(`Creating session ${sessionId} for user ${userId}`);

    // 验证必需参数
    if (!modelConfig.model || !modelConfig.provider) {
      return NextResponse.json(
        { error: 'modelConfig.model and modelConfig.provider are required' },
        { status: 400 },
      );
    }

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

    let firstStepResult;
    if (autoStart) {
      // 使用 AgentRuntimeService 创建会话
      const result = await agentRuntimeService.createSession({
        agentConfig,
        initialContext,
        modelConfig,
        sessionId,
        userId,
      });

      firstStepResult = {
        context: initialContext,
        messageId: result.messageId,
        scheduled: true,
      };

      log(`Session ${sessionId} created and first step scheduled (messageId: ${result.messageId})`);
    }

    return NextResponse.json({
      autoStart,
      createdAt: new Date().toISOString(),
      firstStep: firstStepResult,
      sessionId,
      status: 'created',
      success: true,
    });
  } catch (error: any) {
    log('Failed to create session: %O', error);

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

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId parameter is required' }, { status: 400 });
    }

    // TODO: 实现通过 AgentRuntimeService 获取会话状态
    return NextResponse.json({
      message: 'Session status endpoint not yet implemented with AgentRuntimeService',
      sessionId,
    });
  } catch (error: any) {
    log('Error getting session status: %O', error);

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
