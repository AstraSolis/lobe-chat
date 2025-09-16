import { Client } from '@upstash/qstash';
import debug from 'debug';

import {
  HealthCheckResult,
  HumanInterventionParams,
  QueueStats,
  ScheduleStepParams,
} from '../QueueService';
import { QueueServiceImpl } from './type';

const log = debug('queue:qstash');

/**
 * QStash queue service implementation
 */
export class QStashQueueServiceImpl implements QueueServiceImpl {
  private qstashClient: Client;
  private endpoint: string;

  constructor(config: { endpoint: string; publishUrl?: string; qstashToken: string }) {
    if (!config.qstashToken) {
      throw new Error('QStash token is required for queue service');
    }

    this.qstashClient = new Client({
      token: config.qstashToken,
      ...(config.publishUrl && { publishUrl: config.publishUrl }),
    });
    this.endpoint = config.endpoint;

    log('Initialized with endpoint: %s', this.endpoint);
  }

  async scheduleNextStep(params: ScheduleStepParams): Promise<string> {
    const {
      sessionId,
      stepIndex,
      context,
      delay = 1000,
      priority = 'normal',
      retries = 3,
    } = params;

    try {
      const response = await this.qstashClient.publishJSON({
        body: {
          context,
          priority,
          sessionId,
          stepIndex,
          timestamp: Date.now(),
        },
        delay: delay,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Priority': priority,
          'X-Agent-Session-Id': sessionId,
          'X-Agent-Step-Index': stepIndex.toString(),
        },
        retries,
        url: this.endpoint,
      });

      log(
        'Scheduled step %d for session %s with %dms delay (messageId: %s)',
        stepIndex,
        sessionId,
        delay,
        'messageId' in response ? response.messageId : 'batch-message',
      );

      return 'messageId' in response ? response.messageId : `scheduled-${Date.now()}`;
    } catch (error) {
      log('Failed to schedule step %d for session %s: %O', stepIndex, sessionId, error);
      throw error;
    }
  }

  async scheduleImmediateStep(params: HumanInterventionParams): Promise<string> {
    const { sessionId, stepIndex, context, humanInput, approvedToolCall, rejectionReason } = params;

    try {
      const response = await this.qstashClient.publishJSON({
        body: {
          approvedToolCall,
          context,
          humanInput,
          isHumanIntervention: true,
          priority: 'high',
          rejectionReason,
          sessionId,
          stepIndex,
          timestamp: Date.now(),
        },
        delay: 100,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Human-Intervention': 'true',
          'X-Agent-Priority': 'high',
          'X-Agent-Session-Id': sessionId,
          'X-Agent-Step-Index': stepIndex.toString(),
        },

        // Execute almost immediately
        retries: 3,

        url: this.endpoint,
      });

      log(
        'Scheduled immediate step %d for session %s after human intervention (messageId: %s)',
        stepIndex,
        sessionId,
        'messageId' in response ? response.messageId : 'immediate-message',
      );

      return 'messageId' in response ? response.messageId : `scheduled-${Date.now()}`;
    } catch (error) {
      log('Failed to schedule immediate step %d for session %s: %O', stepIndex, sessionId, error);
      throw error;
    }
  }

  async scheduleBatchSteps(sessions: ScheduleStepParams[]): Promise<string[]> {
    try {
      // Use Promise.all for concurrent execution
      const messageIds = await Promise.all(sessions.map((params) => this.scheduleNextStep(params)));

      log('Scheduled %d batch steps', sessions.length);
      return messageIds;
    } catch (error) {
      log('Failed to schedule batch steps: %O', error);
      throw error;
    }
  }

  async cancelScheduledTask(messageId: string): Promise<void> {
    try {
      // QStash currently doesn't support task cancellation, can record to Redis as cancellation marker
      // Check this marker during actual execution
      log('Requested cancellation for message %s', messageId);

      // TODO: Implement cancellation logic, can store cancellation list via Redis
      // await this.redis.sadd('cancelled_tasks', messageId);
    } catch (error) {
      log('Failed to cancel task %s: %O', messageId, error);
      throw error;
    }
  }

  async getQueueStats(): Promise<QueueStats> {
    return {
      completedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      processingCount: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      // Send a test message to the queue
      const testResponse = await this.qstashClient.publishJSON({
        body: {
          timestamp: Date.now(),
          type: 'health_check',
        },
        delay: 1000,
        retries: 1,
        url: this.getHealthCheckEndpoint(),
      });

      return {
        healthy: true,
        message: `Queue service healthy, test message: ${'messageId' in testResponse ? testResponse.messageId : 'health-check'}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Queue service unhealthy: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Generate health check endpoint from main endpoint
   */
  private getHealthCheckEndpoint(): string {
    try {
      const url = new URL(this.endpoint);
      url.pathname = url.pathname.replace(/\/[^/]*$/, '/health');
      return url.toString();
    } catch {
      // Fallback to simple string replacement
      return this.endpoint.replace(/\/[^/]*$/, '/health');
    }
  }
}
