import debug from 'debug';
import Redis from 'ioredis';

import { getRedisConnectionDescription, getRedisUrl } from './config';

const log = debug('redis:client');

/**
 * 创建 Redis 客户端实例
 */
export function createRedisClient(url?: string): Redis {
  const redisUrl = url || getRedisUrl();

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => {
    log(`Connected to Redis: ${getRedisConnectionDescription(redisUrl)}`);
  });

  client.on('error', (error) => {
    console.error('[Redis Client] Redis connection error:', error);
  });

  client.on('close', () => {
    log('Redis connection closed');
  });

  return client;
}

/**
 * 全局 Redis 客户端实例（单例模式）
 */
let globalRedisClient: Redis | null = null;

/**
 * 获取全局 Redis 客户端实例
 */
export function getRedisClient(): Redis {
  if (!globalRedisClient) {
    globalRedisClient = createRedisClient();
  }
  return globalRedisClient;
}

/**
 * 关闭全局 Redis 客户端连接
 */
export async function closeRedisClient(): Promise<void> {
  if (globalRedisClient) {
    await globalRedisClient.quit();
    globalRedisClient = null;
  }
}
