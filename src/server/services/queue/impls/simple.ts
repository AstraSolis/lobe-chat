import debug from 'debug';

import {
  HealthCheckResult,
  HumanInterventionParams,
  QueueStats,
  ScheduleStepParams,
} from '../QueueService';
import { QueueServiceImpl } from './type';

const log = debug('queue:simple');

/**
 * Simplified queue service implementation for scenarios not using QStash
 */
export class SimpleQueueServiceImpl implements QueueServiceImpl {
  // eslint-disable-next-line no-undef
  private timeouts: Map<string, NodeJS.Timeout> = new Map();

  async scheduleNextStep(params: ScheduleStepParams): Promise<string> {
    const { sessionId, stepIndex, context, delay = 1000 } = params;

    const taskId = `${sessionId}_${stepIndex}_${Date.now()}`;

    const timeout = setTimeout(async () => {
      try {
        // Directly call execution endpoint
        const response = await fetch(process.env.AGENT_STEP_ENDPOINT!, {
          body: JSON.stringify({
            context,
            sessionId,
            stepIndex,
            timestamp: Date.now(),
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        log('Executed step %d for session %s', stepIndex, sessionId);
      } catch (error) {
        log('Failed to execute step %d for session %s: %O', stepIndex, sessionId, error);
      } finally {
        this.timeouts.delete(taskId);
      }
    }, delay);

    this.timeouts.set(taskId, timeout);

    log('Scheduled step %d for session %s with %dms delay', stepIndex, sessionId, delay);

    return taskId;
  }

  async scheduleImmediateStep(params: HumanInterventionParams): Promise<string> {
    return this.scheduleNextStep({ ...params, delay: 100 });
  }

  async scheduleBatchSteps(sessions: ScheduleStepParams[]): Promise<string[]> {
    const taskIds: string[] = [];

    try {
      for (const params of sessions) {
        const taskId = await this.scheduleNextStep(params);
        taskIds.push(taskId);
      }

      log('Scheduled %d batch steps', sessions.length);
      return taskIds;
    } catch (error) {
      log('Failed to schedule batch steps: %O', error);
      throw error;
    }
  }

  async cancelScheduledTask(taskId: string): Promise<void> {
    const timeout = this.timeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(taskId);
      log('Cancelled task %s', taskId);
    }
  }

  async getQueueStats(): Promise<QueueStats> {
    return {
      completedCount: 0,
      failedCount: 0,
      pendingCount: this.timeouts.size,
      processingCount: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      message: `Simple queue service healthy, ${this.timeouts.size} pending tasks`,
    };
  }
}
