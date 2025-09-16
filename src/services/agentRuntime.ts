import { getChatStoreState } from '@/store/chat';
import { chatSelectors } from '@/store/chat/selectors';
import { getAgentStoreState } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { ChatMessage } from '@/types/message';

export interface AgentWorkflowContext {
  files?: string[];
  messages: ChatMessage[];
  sessionId: string;
  threadId?: string;
  topicId?: string;
  userMessage: string;
}

export interface AgentWorkflowStep {
  actions?: string[];
  content?: string;
  id: string;
  reasoning?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  type: 'analysis' | 'planning' | 'execution' | 'response';
}

export interface AgentWorkflowResult {
  error?: string;
  finalResponse: string;
  steps: AgentWorkflowStep[];
  success: boolean;
}

/**
 * Agent Runtime Service for orchestrating complex workflows
 */
export class AgentRuntimeService {
  /**
   * Execute an agent workflow for a given message
   */
  async executeWorkflow(context: AgentWorkflowContext): Promise<AgentWorkflowResult> {
    const { userMessage, messages } = context;

    try {
      // Step 1: Analysis - Understand the user's request
      const analysisStep = await this.analyzeUserRequest(userMessage, messages);

      // Step 2: Planning - Create a plan to handle the request
      const planningStep = await this.createExecutionPlan(analysisStep, context);

      // Step 3: Execution - Execute the planned steps
      const executionSteps = await this.executeSteps(planningStep, context);

      // Step 4: Response - Generate final response
      const responseStep = await this.generateFinalResponse(executionSteps, context);

      const allSteps = [analysisStep, planningStep, ...executionSteps, responseStep];

      return {
        finalResponse: responseStep.content || '',
        steps: allSteps,
        success: true,
      };
    } catch (error) {
      return {
        error: (error as Error).message,
        finalResponse: 'Sorry, I encountered an error while processing your request.',
        steps: [],
        success: false,
      };
    }
  }

  private async analyzeUserRequest(
    userMessage: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _messages: ChatMessage[]
  ): Promise<AgentWorkflowStep> {
    return {
      content: `Analyzing request: "${userMessage}"`,
      id: 'analysis',
      reasoning: 'Understanding the user\'s intent and context from previous conversation.',
      status: 'completed',
      type: 'analysis',
    };
  }

  private async createExecutionPlan(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _analysisStep: AgentWorkflowStep,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: AgentWorkflowContext
  ): Promise<AgentWorkflowStep> {
    return {
      actions: ['Process user request', 'Generate appropriate response'],
      content: 'Creating execution plan based on analysis',
      id: 'planning',
      status: 'completed',
      type: 'planning',
    };
  }

  private async executeSteps(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _planningStep: AgentWorkflowStep,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: AgentWorkflowContext
  ): Promise<AgentWorkflowStep[]> {
    const executionStep: AgentWorkflowStep = {
      content: 'Executing planned actions',
      id: 'execution',
      status: 'completed',
      type: 'execution',
    };

    return [executionStep];
  }

  private async generateFinalResponse(
    executionSteps: AgentWorkflowStep[],
    context: AgentWorkflowContext
  ): Promise<AgentWorkflowStep> {
    // This is where we would integrate with the existing message generation
    // For now, return a placeholder response
    return {
      content: `I've processed your request: "${context.userMessage}". This is an agent-driven response that went through analysis, planning, and execution phases.`,
      id: 'response',
      status: 'completed',
      type: 'response',
    };
  }
}

/**
 * Check if agent mode is enabled for current session
 */
export function isAgentModeEnabled(): boolean {
  const agentStore = getAgentStoreState();
  return agentSelectors.enableAgentMode(agentStore);
}

/**
 * Create agent workflow context from current chat state
 */
export function createAgentWorkflowContext(
  userMessage: string,
  files?: string[]
): AgentWorkflowContext {
  const chatStore = getChatStoreState();
  const messages = chatSelectors.mainAIChats(chatStore);
  const { activeId: sessionId, activeThreadId: threadId, activeTopicId: topicId } = chatStore;

  return {
    files,
    messages,
    sessionId,
    threadId,
    topicId,
    userMessage,
  };
}

// Singleton instance
export const agentRuntimeService = new AgentRuntimeService();
