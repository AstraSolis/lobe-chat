import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as redis from '@/libs/redis';

import { StreamEventManager } from './StreamEventManager';
import type { StreamChunkData, StreamEvent } from './StreamEventManager';

// Mock Redis
const mockRedis = {
  xadd: vi.fn(),
  xread: vi.fn(),
  xrevrange: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
  quit: vi.fn(),
};

vi.mock('@/libs/redis', () => ({
  getRedisClient: vi.fn(() => mockRedis),
}));

vi.mock('debug', () => ({
  __esModule: true,
  default: vi.fn(() => vi.fn()),
}));

describe('StreamEventManager', () => {
  let streamManager: StreamEventManager;

  beforeEach(() => {
    vi.clearAllMocks();
    streamManager = new StreamEventManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with Redis client', () => {
      expect(streamManager).toBeDefined();
      expect((streamManager as any).redis).toBe(mockRedis);
    });

    it('should throw error when Redis is not available', () => {
      vi.mocked(redis.getRedisClient).mockReturnValueOnce(null);

      expect(() => new StreamEventManager()).toThrow(
        'Redis is not available. Please configure REDIS_URL environment variable.',
      );
    });
  });

  describe('publishStreamEvent', () => {
    const mockEvent = {
      type: 'step_start' as const,
      stepIndex: 1,
      data: { sessionId: 'test-session-1', stepIndex: 1 },
    };

    it('should publish stream event successfully', async () => {
      const mockEventId = '1640995200000-0';
      mockRedis.xadd.mockResolvedValue(mockEventId);
      mockRedis.expire.mockResolvedValue(1);

      const result = await streamManager.publishStreamEvent('test-session-1', mockEvent);

      expect(result).toBe(mockEventId);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'type',
        'step_start',
        'stepIndex',
        '1',
        'sessionId',
        'test-session-1',
        'data',
        JSON.stringify(mockEvent.data),
        'timestamp',
        expect.any(String),
      );

      expect(mockRedis.expire).toHaveBeenCalledWith('agent_runtime_stream:test-session-1', 3600);
    });

    it('should handle different event types', async () => {
      const errorEvent = {
        type: 'error' as const,
        stepIndex: 2,
        data: { error: 'Something went wrong', phase: 'step_execution' },
      };

      mockRedis.xadd.mockResolvedValue('1640995201000-0');
      mockRedis.expire.mockResolvedValue(1);

      await streamManager.publishStreamEvent('test-session-1', errorEvent);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'type',
        'error',
        'stepIndex',
        '2',
        'sessionId',
        'test-session-1',
        'data',
        JSON.stringify(errorEvent.data),
        'timestamp',
        expect.any(String),
      );
    });

    it('should handle publish errors', async () => {
      const error = new Error('Redis stream error');
      mockRedis.xadd.mockRejectedValue(error);

      await expect(streamManager.publishStreamEvent('test-session-1', mockEvent)).rejects.toThrow(
        'Redis stream error',
      );
    });
  });

  describe('publishStreamChunk', () => {
    const mockChunkData: StreamChunkData = {
      messageId: 'msg-123',
      chunkType: 'text',
      content: 'Hello world',
      fullContent: 'Hello world, how are you?',
    };

    it('should publish stream chunk successfully', async () => {
      const mockEventId = '1640995200000-1';
      mockRedis.xadd.mockResolvedValue(mockEventId);
      mockRedis.expire.mockResolvedValue(1);

      const result = await streamManager.publishStreamChunk('test-session-1', 2, mockChunkData);

      expect(result).toBe(mockEventId);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'type',
        'stream_chunk',
        'stepIndex',
        '2',
        'sessionId',
        'test-session-1',
        'data',
        JSON.stringify(mockChunkData),
        'timestamp',
        expect.any(String),
      );
    });

    it('should handle different chunk types', async () => {
      const toolCallChunk: StreamChunkData = {
        messageId: 'msg-456',
        chunkType: 'tool_calls',
        toolCalls: [{ toolName: 'calculator', args: { expression: '2+2' } }],
      };

      mockRedis.xadd.mockResolvedValue('1640995201000-1');
      mockRedis.expire.mockResolvedValue(1);

      await streamManager.publishStreamChunk('test-session-1', 3, toolCallChunk);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        'MAXLEN',
        '~',
        '1000',
        '*',
        'type',
        'stream_chunk',
        'stepIndex',
        '3',
        'sessionId',
        'test-session-1',
        'data',
        JSON.stringify(toolCallChunk),
        'timestamp',
        expect.any(String),
      );
    });
  });

  describe('getStreamHistory', () => {
    const mockHistoryData: [string, string[]][] = [
      [
        '1640995202000-0',
        [
          'type',
          'step_complete',
          'stepIndex',
          '2',
          'sessionId',
          'test-session-1',
          'data',
          JSON.stringify({ stepIndex: 2 }),
          'timestamp',
          '1640995202000',
        ],
      ],
      [
        '1640995201000-0',
        [
          'type',
          'step_start',
          'stepIndex',
          '1',
          'sessionId',
          'test-session-1',
          'data',
          JSON.stringify({ stepIndex: 1 }),
          'timestamp',
          '1640995201000',
        ],
      ],
    ];

    it('should get stream history successfully', async () => {
      mockRedis.xrevrange.mockResolvedValue(mockHistoryData);

      const result = await streamManager.getStreamHistory('test-session-1', 50);

      expect(result).toEqual([
        {
          id: '1640995202000-0',
          type: 'step_complete',
          stepIndex: 2,
          sessionId: 'test-session-1',
          data: { stepIndex: 2 },
          timestamp: 1640995202000,
        },
        {
          id: '1640995201000-0',
          type: 'step_start',
          stepIndex: 1,
          sessionId: 'test-session-1',
          data: { stepIndex: 1 },
          timestamp: 1640995201000,
        },
      ]);

      expect(mockRedis.xrevrange).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        '+',
        '-',
        'COUNT',
        50,
      );
    });

    it('should use default count when not specified', async () => {
      mockRedis.xrevrange.mockResolvedValue([]);

      await streamManager.getStreamHistory('test-session-1');

      expect(mockRedis.xrevrange).toHaveBeenCalledWith(
        'agent_runtime_stream:test-session-1',
        '+',
        '-',
        'COUNT',
        100,
      );
    });

    it('should return empty array on error', async () => {
      mockRedis.xrevrange.mockRejectedValue(new Error('Redis error'));

      const result = await streamManager.getStreamHistory('test-session-1');

      expect(result).toEqual([]);
    });

    it('should handle malformed data gracefully', async () => {
      const malformedData: [string, string[]][] = [
        [
          '1640995200000-0',
          ['type', 'step_start', 'data', '"valid json string"', 'stepIndex', 'not a number'],
        ],
      ];

      mockRedis.xrevrange.mockResolvedValue(malformedData);

      const result = await streamManager.getStreamHistory('test-session-1');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('step_start');
      expect(result[0].data).toBe('valid json string'); // Should parse the JSON string
      expect(result[0].stepIndex).toBeNaN(); // parseInt('not a number') = NaN
    });
  });

  describe('cleanupSession', () => {
    it('should cleanup session stream data', async () => {
      mockRedis.del.mockResolvedValue(1);

      await streamManager.cleanupSession('test-session-1');

      expect(mockRedis.del).toHaveBeenCalledWith('agent_runtime_stream:test-session-1');
    });

    it('should handle cleanup errors gracefully', async () => {
      mockRedis.del.mockRejectedValue(new Error('Redis delete error'));

      // Should not throw
      await expect(streamManager.cleanupSession('test-session-1')).resolves.toBeUndefined();
    });
  });

  describe('getActiveSessionsCount', () => {
    it('should get active sessions count successfully', async () => {
      mockRedis.keys.mockResolvedValue([
        'agent_runtime_stream:session-1',
        'agent_runtime_stream:session-2',
        'agent_runtime_stream:session-3',
      ]);

      const result = await streamManager.getActiveSessionsCount();

      expect(result).toBe(3);
      expect(mockRedis.keys).toHaveBeenCalledWith('agent_runtime_stream:*');
    });

    it('should return 0 on error', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));

      const result = await streamManager.getActiveSessionsCount();

      expect(result).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('should close Redis connection', async () => {
      mockRedis.quit.mockResolvedValue('OK');

      await streamManager.disconnect();

      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
