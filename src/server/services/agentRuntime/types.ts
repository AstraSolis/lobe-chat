import { RuntimeContext } from '@lobechat/agent-runtime';

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

export interface SessionStatusResult {
  currentState: {
    cost?: any;
    costLimit?: any;
    error?: string;
    interruption?: any;
    lastModified: string;
    maxSteps?: number;
    pendingHumanPrompt?: any;
    pendingHumanSelect?: any;
    pendingToolsCalling?: any;
    status: string;
    stepCount: number;
    usage?: any;
  };
  executionHistory?: any[];
  hasError: boolean;
  isActive: boolean;
  isCompleted: boolean;
  metadata: any;
  needsHumanInput: boolean;
  recentEvents?: any[];
  sessionId: string;
  stats: {
    lastActiveTime: number;
    totalCost: number;
    totalEvents: number;
    totalMessages: number;
    totalSteps: number;
    uptime: number;
  };
}

export interface PendingInterventionsResult {
  pendingInterventions: Array<{
    lastModified: string;
    modelConfig?: any;
    sessionId: string;
    status: string;
    stepCount: number;
    type: 'tool_approval' | 'human_prompt' | 'human_select';
    userId?: string;
    pendingToolsCalling?: any[];
    pendingHumanPrompt?: any;
    pendingHumanSelect?: any;
  }>;
  timestamp: string;
  totalCount: number;
}