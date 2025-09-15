import debug from 'debug';

import { QStashQueueServiceImpl } from './qstash';
import { SimpleQueueServiceImpl } from './simple';
import { QueueServiceImpl } from './type';

const log = debug('queue:factory');

/**
 * Create queue service module
 * Automatically select QStash or simple queue implementation based on environment variables
 */
export const createQueueServiceModule = (): QueueServiceImpl => {
  // Check if QStash is configured
  const qstashToken = process.env.QSTASH_TOKEN;
  const endpoint = process.env.AGENT_STEP_ENDPOINT;

  if (qstashToken && endpoint) {
    log('Using QStash implementation');
    return new QStashQueueServiceImpl({
      endpoint,
      publishUrl: process.env.QSTASH_PUBLISH_URL,
      qstashToken,
    });
  }

  log('Using Simple queue implementation');
  return new SimpleQueueServiceImpl();
};

export type { QueueServiceImpl } from './type';
