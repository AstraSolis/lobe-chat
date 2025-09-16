// import { createServerSentEventStream } from '@/utils/fetch';

export interface StreamEvent {
  data?: any;
  sessionId?: string;
  stepIndex?: number;
  timestamp: number;
  type: 'connected' | 'step_start' | 'step_complete' | 'llm_stream_chunk' | 'llm_stream_complete' | 'tool_start' | 'tool_complete' | 'human_approval_request' | 'error' | 'heartbeat';
}

export interface StreamConnectionOptions {
  includeHistory?: boolean;
  lastEventId?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onEvent?: (event: StreamEvent) => void;
}

export interface AgentSessionRequest {
  agentConfig?: {
    [key: string]: any;
    costLimit?: {
      currency: string;
      maxTotalCost: number;
      onExceeded: 'stop' | 'interrupt' | 'continue';
    };
    enableRAG?: boolean;
    enableSearch?: boolean;
    humanApprovalRequired?: boolean;
    maxSteps?: number;
  };
  autoStart?: boolean;
  messages?: Array<{
    content: string;
    role: string;
    tool_calls?: Array<{
      function: { arguments: string, name: string; };
      id: string;
    }>;
  }>;
  modelConfig: {
    [key: string]: any;
    model: string;
    provider: string;
  };
  sessionId?: string;
  userId?: string;
}

export interface AgentSessionResponse {
  createdAt: string;
  firstStep?: {
    context?: any;
    error?: string;
    messageId?: string;
    scheduled: boolean;
  };
  initialState: {
    costLimit?: any;
    maxSteps?: number;
    messageCount: number;
    status: string;
    stepCount: number;
  };
  sessionId: string;
  status: string;
  success: boolean;
}

export interface HumanInterventionRequest {
  action: 'approve' | 'reject' | 'modify';
  data?: any;
  sessionId: string;
}

/**
 * Agent Client Service for communicating with durable agents
 */
class AgentClientService {
  private baseUrl = '/api/agent';

  /**
   * Create a new agent session
   */
  async createSession(request: AgentSessionRequest): Promise<AgentSessionResponse> {
    const response = await fetch(`${this.baseUrl}/session`, {
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create agent session' }));
      throw new Error(error.error || 'Failed to create agent session');
    }

    return response.json();
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId: string, includeHistory = false): Promise<any> {
    const params = new URLSearchParams({
      includeHistory: includeHistory.toString(),
      sessionId,
    });

    const response = await fetch(`${this.baseUrl}/session?${params}`, {
      method: 'GET',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to get session status' }));
      throw new Error(error.error || 'Failed to get session status');
    }

    return response.json();
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session?sessionId=${sessionId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to delete session' }));
      throw new Error(error.error || 'Failed to delete session');
    }
  }

  /**
   * Handle human intervention
   */
  async handleHumanIntervention(request: HumanInterventionRequest): Promise<any> {
    const response = await fetch(`${this.baseUrl}/human-intervention`, {
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to handle human intervention' }));
      throw new Error(error.error || 'Failed to handle human intervention');
    }

    return response.json();
  }

  /**
   * Create a streaming connection to receive real-time agent events
   */
  createStreamConnection(
    sessionId: string,
    options: StreamConnectionOptions = {}
  ): EventSource {
    const {
      includeHistory = false,
      lastEventId = '0',
      onEvent,
      onError,
      onConnect,
      onDisconnect,
    } = options;

    const params = new URLSearchParams({
      includeHistory: includeHistory.toString(),
      lastEventId,
      sessionId,
    });

    const eventSource = new EventSource(`${this.baseUrl}/stream?${params}`);

    eventSource.addEventListener('open', () => {
      console.log(`[AgentClientService] Stream connection opened for session ${sessionId}`);
      onConnect?.();
    });

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StreamEvent;
        onEvent?.(data);
      } catch (error) {
        console.error('[AgentClientService] Failed to parse stream event:', error);
        onError?.(new Error('Failed to parse stream event'));
      }
    };

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    eventSource.onerror = (event) => {
      console.error(`[AgentClientService] Stream error for session ${sessionId}:`, event);

      // EventSource automatically reconnects, but we can handle specific error types
      if (eventSource.readyState === EventSource.CLOSED) {
        console.log(`[AgentClientService] Stream connection closed for session ${sessionId}`);
        onDisconnect?.();
      } else {
        onError?.(new Error('Stream connection error'));
      }
    };

    // Custom cleanup method
    const originalClose = eventSource.close.bind(eventSource);
    eventSource.close = () => {
      console.log(`[AgentClientService] Closing stream connection for session ${sessionId}`);
      originalClose();
      onDisconnect?.();
    };

    return eventSource;
  }

  /**
   * Execute a single step manually (mainly for debugging)
   */
  async executeStep(sessionId: string, options: {
    approvedToolCall?: any;
    context?: any;
    forceComplete?: boolean;
    humanInput?: any;
    priority?: 'low' | 'normal' | 'high';
    rejectionReason?: string;
    stepIndex?: number;
  } = {}): Promise<any> {
    const response = await fetch(`${this.baseUrl}/execute-step`, {
      body: JSON.stringify({
        sessionId,
        ...options,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to execute step' }));
      throw new Error(error.error || 'Failed to execute step');
    }

    return response.json();
  }

  /**
   * Get service health status
   */
  async healthCheck(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/execute-step`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error('Health check failed');
    }

    return response.json();
  }
}

export const agentClientService = new AgentClientService();
