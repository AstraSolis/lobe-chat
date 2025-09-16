import { AgentRuntime, RuntimeContext } from '@lobechat/agent-runtime';
import debug from 'debug';

import {
  AgentStateManager,
  DurableLobeChatAgent,
  StreamEventManager,
  createStreamingFinishExecutor,
  createStreamingHumanApprovalExecutor,
  createStreamingLLMExecutor,
  createStreamingToolExecutor,
} from '@/server/modules/AgentRuntime';
import { QueueService } from '@/server/services/queue';

const log = debug('agent-runtime-service');

export interface AgentExecutionParams {
  approvedToolCall?: any;
  context?: RuntimeContext;
  humanInput?: any;
  rejectionReason?: string;
  sessionId: string;
  stepIndex: number;
}

export interface AgentExecutionResult {
  nextStepScheduled: boolean;
  state: any;
  stepResult?: any;
  success: boolean;
}

export interface SessionCreationParams {
  agentConfig?: any;
  initialContext: RuntimeContext;
  modelConfig?: any;
  sessionId: string;
  userId?: string;
}

export interface SessionCreationResult {
  messageId: string;
  sessionId: string;
  success: boolean;
}

/**
 * Agent Runtime Service
 * 封装 Agent 执行相关的逻辑，提供统一的服务接口
 */
export class AgentRuntimeService {
  private stateManager: AgentStateManager;
  private streamManager: StreamEventManager;
  private queueService: QueueService;
  private baseURL: string;

  constructor() {
    this.stateManager = new AgentStateManager();
    this.streamManager = new StreamEventManager();
    this.queueService = new QueueService();
    this.baseURL = process.env.AGENT_RUNTIME_BASE_URL || 'http://localhost:3000/api/agent';
  }

  /**
   * 创建新的 Agent 会话
   */
  async createSession(params: SessionCreationParams): Promise<SessionCreationResult> {
    const { sessionId, initialContext, agentConfig, modelConfig, userId } = params;

    try {
      log('Creating new session %s', sessionId);

      // 初始化会话状态 - 先创建状态再保存
      const initialState = {
        events: [],
        lastModified: new Date().toISOString(),
        messages: [],
        metadata: {
          agentConfig,
          createdAt: new Date().toISOString(),
          modelConfig,
          userId,
        },
        sessionId,
        status: 'idle',
        stepCount: 0,
      };

      await this.stateManager.saveAgentState(sessionId, initialState as any);
      await this.stateManager.createSessionMetadata(sessionId, {
        agentConfig,
        modelConfig,
        userId,
      });

      // 调度第一步执行
      const messageId = await this.queueService.scheduleMessage({
        context: initialContext,
        delay: 500, // 短延迟启动
        endpoint: `${this.baseURL}/run`,
        priority: 'high',
        sessionId,
        stepIndex: 0,
      });

      log('Scheduled first step for session %s (messageId: %s)', sessionId, messageId);

      return {
        messageId,
        sessionId,
        success: true,
      };
    } catch (error) {
      log('Failed to create session %s: %O', sessionId, error);
      throw error;
    }
  }

  /**
   * 执行 Agent 步骤
   */
  async executeStep(params: AgentExecutionParams): Promise<AgentExecutionResult> {
    const { sessionId, stepIndex, context, humanInput, approvedToolCall, rejectionReason } = params;

    try {
      log('Executing step %d for session %s', stepIndex, sessionId);

      // 发布步骤开始事件
      await this.streamManager.publishStreamEvent(sessionId, {
        data: { sessionId, stepIndex },
        stepIndex,
        type: 'step_start',
      });

      // 获取会话状态和元数据
      const [agentState, sessionMetadata] = await Promise.all([
        this.stateManager.loadAgentState(sessionId),
        this.stateManager.getSessionMetadata(sessionId),
      ]);

      if (!agentState) {
        throw new Error(`Agent state not found for session ${sessionId}`);
      }

      // 创建 Agent 和 Runtime 实例
      const { agent, runtime } = this.createAgentRuntime(sessionId, sessionMetadata);

      // 处理人工干预
      let currentContext = context;
      let currentState = agentState;

      if (humanInput || approvedToolCall || rejectionReason) {
        const interventionResult = await this.handleHumanIntervention(runtime, currentState, {
          approvedToolCall,
          humanInput,
          rejectionReason,
        });
        currentState = interventionResult.newState;
        currentContext = interventionResult.nextContext;
      }

      // 执行步骤
      const stepResult = await runtime.step(currentState, currentContext);

      // 保存状态
      await this.stateManager.saveStepResult(sessionId, {
        ...stepResult,
        executionTime: Date.now() - Date.now(),
        stepIndex, // placeholder
      });

      // 决定是否调度下一步
      const shouldContinue = this.shouldContinueExecution(
        stepResult.newState,
        stepResult.nextContext,
      );
      let nextStepScheduled = false;

      if (shouldContinue && stepResult.nextContext) {
        const nextStepIndex = stepIndex + 1;
        const delay = this.calculateStepDelay(stepResult);
        const priority = this.calculatePriority(stepResult);

        await this.queueService.scheduleMessage({
          context: stepResult.nextContext,
          delay,
          endpoint: `${this.baseURL}/run`,
          priority,
          sessionId,
          stepIndex: nextStepIndex,
        });
        nextStepScheduled = true;

        log('Scheduled next step %d for session %s', nextStepIndex, sessionId);
      }

      // 发布步骤完成事件
      await this.streamManager.publishStreamEvent(sessionId, {
        data: {
          finalState: stepResult.newState,
          nextStepScheduled,
          stepIndex,
        },
        stepIndex,
        type: 'step_complete',
      });

      log('Step %d completed for session %s', stepIndex, sessionId);

      return {
        nextStepScheduled,
        state: stepResult.newState,
        stepResult,
        success: true,
      };
    } catch (error) {
      log('Step %d failed for session %s: %O', stepIndex, sessionId, error);

      // 发布错误事件
      await this.streamManager.publishStreamEvent(sessionId, {
        data: {
          error: (error as Error).message,
          phase: 'step_execution',
          stepIndex,
        },
        stepIndex,
        type: 'error',
      });

      throw error;
    }
  }

  /**
   * 处理人工干预
   */
  async processHumanIntervention(params: {
    action: 'approve' | 'reject' | 'input' | 'select';
    approvedToolCall?: any;
    humanInput?: any;
    rejectionReason?: string;
    sessionId: string;
    stepIndex: number;
  }): Promise<{ messageId: string }> {
    const { sessionId, stepIndex, action, approvedToolCall, humanInput, rejectionReason } = params;

    try {
      log(
        'Processing human intervention for session %s:%d (action: %s)',
        sessionId,
        stepIndex,
        action,
      );

      // 高优先级调度执行
      const messageId = await this.queueService.scheduleMessage({
        context: undefined, // 会从状态管理器中获取
        delay: 100,
        endpoint: `${this.baseURL}/run`,
        payload: { approvedToolCall, humanInput, rejectionReason },
        priority: 'high',
        sessionId,
        stepIndex,
      });

      log('Scheduled immediate execution for session %s (messageId: %s)', sessionId, messageId);

      return { messageId };
    } catch (error) {
      log('Failed to process human intervention for session %s: %O', sessionId, error);
      throw error;
    }
  }

  /**
   * 创建 Agent Runtime 实例
   */
  private createAgentRuntime(sessionId: string, sessionMetadata?: any) {
    // 创建 Durable Agent 实例
    const agent = new DurableLobeChatAgent({
      agentConfig: sessionMetadata?.agentConfig,
      modelConfig: sessionMetadata?.modelConfig,
      sessionId,
      userId: sessionMetadata?.userId,
    });

    // 创建流式执行器上下文
    const executorContext = {
      sessionId,
      stepIndex: 0, // 会在执行时动态设置
      streamManager: this.streamManager,
      userId: sessionMetadata?.userId,
    };

    // 创建 Agent Runtime 实例
    const runtime = new AgentRuntime(agent as any, {
      executors: {
        call_llm: createStreamingLLMExecutor(executorContext),
        call_tool: createStreamingToolExecutor(executorContext),
        finish: createStreamingFinishExecutor(executorContext),
        request_human_approve: createStreamingHumanApprovalExecutor(executorContext),
      },
    });

    return { agent, runtime };
  }

  /**
   * 处理人工干预逻辑
   */
  private async handleHumanIntervention(
    runtime: AgentRuntime,
    state: any,
    intervention: { approvedToolCall?: any; humanInput?: any; rejectionReason?: string },
  ) {
    const { humanInput, approvedToolCall, rejectionReason } = intervention;

    if (approvedToolCall && state.status === 'waiting_for_human_input') {
      // TODO: 实现 approveToolCall 逻辑
      return { newState: state, nextContext: undefined };
    } else if (rejectionReason && state.status === 'waiting_for_human_input') {
      // TODO: 实现 rejectToolCall 逻辑
      return { newState: state, nextContext: undefined };
    } else if (humanInput) {
      // TODO: 实现 processHumanInput 逻辑
      return { newState: state, nextContext: undefined };
    }

    return { newState: state, nextContext: undefined };
  }

  /**
   * 决定是否继续执行
   */
  private shouldContinueExecution(state: any, context?: any): boolean {
    // 已完成
    if (state.status === 'done') return false;

    // 需要人工干预
    if (state.status === 'waiting_for_human_input') return false;

    // 出错了
    if (state.status === 'error') return false;

    // 被中断
    if (state.status === 'interrupted') return false;

    // 达到最大步数
    if (state.maxSteps && state.stepCount >= state.maxSteps) return false;

    // 超过成本限制
    if (state.costLimit && state.cost?.total >= state.costLimit.maxTotalCost) {
      return state.costLimit.onExceeded !== 'stop';
    }

    // 没有下一个上下文
    if (!context) return false;

    return true;
  }

  /**
   * 计算步骤延迟
   */
  private calculateStepDelay(stepResult: any): number {
    const baseDelay = 1000;

    // 如果有工具调用，延迟长一点
    if (stepResult.events?.some((e: any) => e.type === 'tool_result')) {
      return baseDelay + 1000;
    }

    // 如果有错误，使用指数退避
    if (stepResult.events?.some((e: any) => e.type === 'error')) {
      return Math.min(baseDelay * 2, 10_000);
    }

    return baseDelay;
  }

  /**
   * 计算优先级
   */
  private calculatePriority(stepResult: any): 'high' | 'normal' | 'low' {
    // 如果需要人工干预，高优先级
    if (stepResult.newState?.status === 'waiting_for_human_input') {
      return 'high';
    }

    // 如果有错误，正常优先级
    if (stepResult.events?.some((e: any) => e.type === 'error')) {
      return 'normal';
    }

    return 'normal';
  }
}
