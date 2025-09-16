import { HealthCheckResult, QueueMessage, QueueStats } from '../types';

/**
 * Queue service implementation interface
 */
export interface QueueServiceImpl {
  /**
   * Cancel scheduled task
   */
  cancelScheduledTask(taskId: string): Promise<void>;

  /**
   * Get queue statistics
   */
  getQueueStats(): Promise<QueueStats>;

  /**
   * Health check
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Schedule a message to the queue
   */
  scheduleMessage(message: QueueMessage): Promise<string>;

  /**
   * Schedule multiple messages to the queue
   */
  scheduleBatchMessages(messages: QueueMessage[]): Promise<string[]>;
}
