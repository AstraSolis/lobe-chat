import {
  HealthCheckResult,
  HumanInterventionParams,
  QueueStats,
  ScheduleStepParams,
} from '../QueueService';

/**
 * Queue service implementation interface
 */
export interface QueueServiceImpl {
  /**
   * Schedule next Agent execution step
   */
  scheduleNextStep(params: ScheduleStepParams): Promise<string>;

  /**
   * High priority execution (immediate resume after human intervention)
   */
  scheduleImmediateStep(params: HumanInterventionParams): Promise<string>;

  /**
   * Batch schedule multiple steps (for resuming interrupted sessions)
   */
  scheduleBatchSteps(sessions: ScheduleStepParams[]): Promise<string[]>;

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
}