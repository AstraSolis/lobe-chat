import { RuntimeContext } from '@lobechat/agent-runtime';

import { QueueServiceImpl, createQueueServiceModule } from './impls';

export interface ScheduleStepParams {
  context?: RuntimeContext;
  delay?: number;
  priority?: 'high' | 'normal' | 'low';
  retries?: number;
  sessionId: string;
  stepIndex: number;
}

export interface HumanInterventionParams {
  approvedToolCall?: any;
  context?: RuntimeContext;
  humanInput?: any;
  rejectionReason?: string;
  sessionId: string;
  stepIndex: number;
}

export interface QueueStats {
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  processingCount: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
}

/**
 * Queue Service
 * Uses modular implementation approach to provide queue operation services
 */
export class QueueService {
  private impl: QueueServiceImpl = createQueueServiceModule();

  /**
   * Schedule next Agent execution step
   */
  async scheduleNextStep(params: ScheduleStepParams): Promise<string> {
    return this.impl.scheduleNextStep(params);
  }

  /**
   * High priority execution (immediate resume after human intervention)
   */
  async scheduleImmediateStep(params: HumanInterventionParams): Promise<string> {
    return this.impl.scheduleImmediateStep(params);
  }

  /**
   * Batch schedule multiple steps (for resuming interrupted sessions)
   */
  async scheduleBatchSteps(sessions: ScheduleStepParams[]): Promise<string[]> {
    return this.impl.scheduleBatchSteps(sessions);
  }

  /**
   * Cancel scheduled task
   */
  async cancelScheduledTask(taskId: string): Promise<void> {
    return this.impl.cancelScheduledTask(taskId);
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    return this.impl.getQueueStats();
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    return this.impl.healthCheck();
  }

  /**
   * Calculate delay time (dynamically adjusted based on different situations)
   */
  static calculateDelay(params: {
    hasErrors: boolean;
    hasToolCalls: boolean;
    priority: 'high' | 'normal' | 'low';
    stepIndex: number;
  }): number {
    const { stepIndex, hasErrors, hasToolCalls, priority } = params;

    let baseDelay = 1000; // 1 second base delay

    // Adjust based on priority
    switch (priority) {
      case 'high': {
        baseDelay = 200;
        break;
      }
      case 'low': {
        baseDelay = 5000;
        break;
      }
      default: {
        baseDelay = 1000;
      }
    }

    // If there are tool calls, delay a bit longer to wait for tool execution completion
    if (hasToolCalls) {
      baseDelay += 1000;
    }

    // If there are errors, delay longer to avoid consecutive failures
    if (hasErrors) {
      baseDelay += Math.min(stepIndex * 1000, 10_000); // Exponential backoff, max 10 seconds
    }

    return baseDelay;
  }
}
