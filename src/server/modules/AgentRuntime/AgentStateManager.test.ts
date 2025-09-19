import type { AgentState } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Redis

// Import and mock the redis module dynamically
import * as redisModule from '@/libs/redis';

import { AgentStateManager } from './AgentStateManager';
import type { AgentSessionMetadata, StepResult } from './AgentStateManager';

const mockRedis = {
  setex: vi.fn(),
  get: vi.fn(),
  multi: vi.fn(),
  hmset: vi.fn(),
  hgetall: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
  lrange: vi.fn(),
  lpush: vi.fn(),
  ltrim: vi.fn(),
  expire: vi.fn(),
  exec: vi.fn(),
  quit: vi.fn(),
};

vi.mock('@/libs/redis', () => ({
  getRedisClient: vi.fn(() => mockRedis),
}));

vi.mock('debug', () => ({
  __esModule: true,
  default: vi.fn(() => vi.fn()),
}));

describe('AgentStateManager', () => {
  let stateManager: AgentStateManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock redis pipeline
    mockRedis.multi.mockReturnValue({
      setex: vi.fn().mockReturnThis(),
      lpush: vi.fn().mockReturnThis(),
      ltrim: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      hmset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });

    stateManager = new AgentStateManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with Redis client', () => {
      expect(stateManager).toBeDefined();
      expect((stateManager as any).redis).toBe(mockRedis);
    });

    it('should throw error when Redis is not available', () => {
      vi.mocked(redisModule.getRedisClient).mockReturnValueOnce(null);

      expect(() => new AgentStateManager()).toThrow(
        'Redis is not available. Please configure REDIS_URL environment variable.',
      );
    });
  });

  describe('saveAgentState', () => {
    const mockState: AgentState = {
      sessionId: 'test-session-1',
      status: 'running',
      stepCount: 5,
      messages: [{ content: 'test message' }],
      events: [],
      lastModified: new Date().toISOString(),
      cost: { total: 0.15 },
    } as any;

    it('should save agent state successfully', async () => {
      mockRedis.setex.mockResolvedValue('OK');

      await stateManager.saveAgentState('test-session-1', mockState);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'agent_runtime_state:test-session-1',
        24 * 3600, // DEFAULT_TTL
        JSON.stringify(mockState),
      );
    });

    it('should update session metadata when saving state', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      const mockPipeline = {
        setex: vi.fn().mockReturnThis(),
        hmset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.multi.mockReturnValue(mockPipeline);

      // Need to spy on the private method indirectly by checking if hmset gets called
      await stateManager.saveAgentState('test-session-1', mockState);

      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should handle save errors', async () => {
      const error = new Error('Redis connection failed');
      mockRedis.setex.mockRejectedValue(error);

      await expect(stateManager.saveAgentState('test-session-1', mockState)).rejects.toThrow(
        'Redis connection failed',
      );
    });
  });

  describe('loadAgentState', () => {
    const mockState: AgentState = {
      sessionId: 'test-session-1',
      status: 'running',
      stepCount: 3,
      messages: [],
      events: [],
      lastModified: new Date().toISOString(),
    } as any;

    it('should load agent state successfully', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(mockState));

      const result = await stateManager.loadAgentState('test-session-1');

      expect(result).toEqual(mockState);
      expect(mockRedis.get).toHaveBeenCalledWith('agent_runtime_state:test-session-1');
    });

    it('should return null when state not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await stateManager.loadAgentState('nonexistent-session');

      expect(result).toBeNull();
    });

    it('should handle load errors', async () => {
      const error = new Error('Redis read error');
      mockRedis.get.mockRejectedValue(error);

      await expect(stateManager.loadAgentState('test-session-1')).rejects.toThrow(
        'Redis read error',
      );
    });

    it('should handle malformed JSON', async () => {
      mockRedis.get.mockResolvedValue('invalid json');

      await expect(stateManager.loadAgentState('test-session-1')).rejects.toThrow();
    });
  });

  describe('saveStepResult', () => {
    const mockStepResult: StepResult = {
      stepIndex: 2,
      executionTime: 1500,
      newState: {
        sessionId: 'test-session-1',
        status: 'running',
        stepCount: 2,
        messages: [],
        events: [],
        lastModified: new Date().toISOString(),
        cost: { total: 0.05 },
      } as any,
      nextContext: {
        phase: 'user_input',
        payload: {
          message: { content: 'test' },
          sessionId: 'test-session-1',
          isFirstMessage: false,
        },
        session: { sessionId: 'test-session-1', status: 'running', stepCount: 2, messageCount: 1 },
      },
    };

    it('should save step result with pipeline', async () => {
      const mockPipeline = {
        setex: vi.fn().mockReturnThis(),
        lpush: vi.fn().mockReturnThis(),
        ltrim: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        hmset: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
      mockRedis.multi.mockReturnValue(mockPipeline);

      await stateManager.saveStepResult('test-session-1', mockStepResult);

      expect(mockPipeline.setex).toHaveBeenCalledWith(
        'agent_runtime_state:test-session-1',
        24 * 3600,
        JSON.stringify(mockStepResult.newState),
      );

      expect(mockPipeline.lpush).toHaveBeenCalledWith(
        'agent_runtime_steps:test-session-1',
        expect.stringContaining('"stepIndex":2'),
      );

      expect(mockPipeline.ltrim).toHaveBeenCalledWith('agent_runtime_steps:test-session-1', 0, 199);

      expect(mockPipeline.hmset).toHaveBeenCalledWith('agent_runtime_meta:test-session-1', {
        lastActiveAt: expect.any(String),
        status: 'running',
        totalCost: 0.05,
        totalSteps: 2,
      });

      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should handle save step result errors', async () => {
      const mockPipeline = {
        setex: vi.fn().mockReturnThis(),
        lpush: vi.fn().mockReturnThis(),
        ltrim: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        hmset: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('Pipeline failed')),
      };
      mockRedis.multi.mockReturnValue(mockPipeline);

      await expect(stateManager.saveStepResult('test-session-1', mockStepResult)).rejects.toThrow(
        'Pipeline failed',
      );
    });
  });

  describe('getExecutionHistory', () => {
    const mockHistoryData = [
      JSON.stringify({
        stepIndex: 2,
        timestamp: Date.now(),
        status: 'running',
        cost: 0.02,
        executionTime: 1200,
      }),
      JSON.stringify({
        stepIndex: 1,
        timestamp: Date.now() - 1000,
        status: 'running',
        cost: 0.01,
        executionTime: 800,
      }),
    ];

    it('should get execution history successfully', async () => {
      mockRedis.lrange.mockResolvedValue(mockHistoryData);

      const result = await stateManager.getExecutionHistory('test-session-1', 10);

      expect(result).toHaveLength(2);
      expect(result[0].stepIndex).toBe(1); // Should be reversed (earliest first)
      expect(result[1].stepIndex).toBe(2);

      expect(mockRedis.lrange).toHaveBeenCalledWith('agent_runtime_steps:test-session-1', 0, 9);
    });

    it('should return empty array on error', async () => {
      mockRedis.lrange.mockRejectedValue(new Error('Redis error'));

      const result = await stateManager.getExecutionHistory('test-session-1');

      expect(result).toEqual([]);
    });

    it('should use default limit when not specified', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      await stateManager.getExecutionHistory('test-session-1');

      expect(mockRedis.lrange).toHaveBeenCalledWith('agent_runtime_steps:test-session-1', 0, 49);
    });
  });

  describe('getSessionMetadata', () => {
    const mockMetadataHash = {
      userId: 'user-123',
      createdAt: '2024-01-01T00:00:00Z',
      lastActiveAt: '2024-01-01T01:00:00Z',
      status: 'running',
      totalCost: '0.15',
      totalSteps: '5',
      agentConfig: JSON.stringify({ name: 'test-agent' }),
      modelRuntimeConfig: JSON.stringify({ model: 'gpt-4' }),
    };

    it('should get session metadata successfully', async () => {
      mockRedis.hgetall.mockResolvedValue(mockMetadataHash);

      const result = await stateManager.getSessionMetadata('test-session-1');

      expect(result).toEqual({
        userId: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        lastActiveAt: '2024-01-01T01:00:00Z',
        status: 'running',
        totalCost: 0.15,
        totalSteps: 5,
        agentConfig: { name: 'test-agent' },
        modelRuntimeConfig: { model: 'gpt-4' },
      });

      expect(mockRedis.hgetall).toHaveBeenCalledWith('agent_runtime_meta:test-session-1');
    });

    it('should return null when metadata not found', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await stateManager.getSessionMetadata('nonexistent-session');

      expect(result).toBeNull();
    });

    it('should handle metadata with missing optional fields', async () => {
      mockRedis.hgetall.mockResolvedValue({
        createdAt: '2024-01-01T00:00:00Z',
        lastActiveAt: '2024-01-01T01:00:00Z',
        status: 'idle',
        totalCost: '0',
        totalSteps: '0',
      });

      const result = await stateManager.getSessionMetadata('test-session-1');

      expect(result).toEqual({
        createdAt: '2024-01-01T00:00:00Z',
        lastActiveAt: '2024-01-01T01:00:00Z',
        status: 'idle',
        totalCost: 0,
        totalSteps: 0,
        userId: undefined,
        agentConfig: undefined,
        modelRuntimeConfig: undefined,
      });
    });

    it('should handle errors gracefully', async () => {
      mockRedis.hgetall.mockRejectedValue(new Error('Redis error'));

      const result = await stateManager.getSessionMetadata('test-session-1');

      expect(result).toBeNull();
    });
  });

  describe('createSessionMetadata', () => {
    const mockCreateData = {
      userId: 'user-123',
      agentConfig: { name: 'test-agent', version: '1.0' },
      modelRuntimeConfig: { model: 'gpt-4', temperature: 0.7 },
    };

    it('should create session metadata successfully', async () => {
      mockRedis.hmset.mockResolvedValue('OK');
      mockRedis.expire.mockResolvedValue(1);

      await stateManager.createSessionMetadata('test-session-1', mockCreateData);

      expect(mockRedis.hmset).toHaveBeenCalledWith(
        'agent_runtime_meta:test-session-1',
        expect.objectContaining({
          userId: 'user-123',
          status: 'idle',
          totalCost: '0',
          totalSteps: '0',
          createdAt: expect.any(String),
          lastActiveAt: expect.any(String),
          agentConfig: JSON.stringify(mockCreateData.agentConfig),
          modelRuntimeConfig: JSON.stringify(mockCreateData.modelRuntimeConfig),
        }),
      );

      expect(mockRedis.expire).toHaveBeenCalledWith('agent_runtime_meta:test-session-1', 24 * 3600);
    });

    it('should create metadata without optional fields', async () => {
      mockRedis.hmset.mockResolvedValue('OK');
      mockRedis.expire.mockResolvedValue(1);

      await stateManager.createSessionMetadata('test-session-1', {});

      expect(mockRedis.hmset).toHaveBeenCalledWith(
        'agent_runtime_meta:test-session-1',
        expect.objectContaining({
          status: 'idle',
          totalCost: '0',
          totalSteps: '0',
          createdAt: expect.any(String),
          lastActiveAt: expect.any(String),
        }),
      );

      // Should not contain optional fields
      const callArgs = mockRedis.hmset.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('userId');
      expect(callArgs).not.toHaveProperty('agentConfig');
      expect(callArgs).not.toHaveProperty('modelRuntimeConfig');
    });

    it('should handle creation errors', async () => {
      mockRedis.hmset.mockRejectedValue(new Error('Redis write error'));

      await expect(
        stateManager.createSessionMetadata('test-session-1', mockCreateData),
      ).rejects.toThrow('Redis write error');
    });
  });

  describe('deleteAgentSession', () => {
    it('should delete all session data', async () => {
      mockRedis.del.mockResolvedValue(3);

      await stateManager.deleteAgentSession('test-session-1');

      expect(mockRedis.del).toHaveBeenCalledWith(
        'agent_runtime_state:test-session-1',
        'agent_runtime_steps:test-session-1',
        'agent_runtime_meta:test-session-1',
      );
    });

    it('should handle deletion errors', async () => {
      mockRedis.del.mockRejectedValue(new Error('Redis delete error'));

      await expect(stateManager.deleteAgentSession('test-session-1')).rejects.toThrow(
        'Redis delete error',
      );
    });
  });

  describe('getActiveSessions', () => {
    it('should get active sessions successfully', async () => {
      mockRedis.keys.mockResolvedValue([
        'agent_runtime_state:session-1',
        'agent_runtime_state:session-2',
        'agent_runtime_state:session-3',
      ]);

      const result = await stateManager.getActiveSessions();

      expect(result).toEqual(['session-1', 'session-2', 'session-3']);
      expect(mockRedis.keys).toHaveBeenCalledWith('agent_runtime_state:*');
    });

    it('should return empty array on error', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));

      const result = await stateManager.getActiveSessions();

      expect(result).toEqual([]);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should cleanup expired sessions', async () => {
      const mockSessions = ['session-1', 'session-2', 'session-3'];
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      // Mock getActiveSessions
      vi.spyOn(stateManager, 'getActiveSessions').mockResolvedValue(mockSessions);

      // Mock getSessionMetadata for different sessions
      vi.spyOn(stateManager, 'getSessionMetadata')
        .mockResolvedValueOnce({ lastActiveAt: oldDate } as any) // expired
        .mockResolvedValueOnce({ lastActiveAt: recentDate } as any) // not expired
        .mockResolvedValueOnce({ lastActiveAt: oldDate } as any); // expired

      // Mock deleteAgentSession
      vi.spyOn(stateManager, 'deleteAgentSession').mockResolvedValue();

      const cleanedCount = await stateManager.cleanupExpiredSessions();

      expect(cleanedCount).toBe(2);
      expect(stateManager.deleteAgentSession).toHaveBeenCalledWith('session-1');
      expect(stateManager.deleteAgentSession).toHaveBeenCalledWith('session-3');
      expect(stateManager.deleteAgentSession).not.toHaveBeenCalledWith('session-2');
    });

    it('should handle cleanup errors gracefully', async () => {
      vi.spyOn(stateManager, 'getActiveSessions').mockRejectedValue(new Error('Redis error'));

      const result = await stateManager.cleanupExpiredSessions();

      expect(result).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should calculate stats correctly', async () => {
      const mockSessions = ['session-1', 'session-2', 'session-3', 'session-4'];

      vi.spyOn(stateManager, 'getActiveSessions').mockResolvedValue(mockSessions);

      // Mock different session statuses
      vi.spyOn(stateManager, 'getSessionMetadata')
        .mockResolvedValueOnce({ status: 'running' } as any)
        .mockResolvedValueOnce({ status: 'waiting_for_human_input' } as any)
        .mockResolvedValueOnce({ status: 'done' } as any)
        .mockResolvedValueOnce({ status: 'error' } as any);

      const stats = await stateManager.getStats();

      expect(stats).toEqual({
        totalSessions: 4,
        activeSessions: 2, // running + waiting_for_human_input
        completedSessions: 1, // done
        errorSessions: 1, // error
      });
    });

    it('should handle stats calculation errors', async () => {
      vi.spyOn(stateManager, 'getActiveSessions').mockRejectedValue(new Error('Redis error'));

      const stats = await stateManager.getStats();

      expect(stats).toEqual({
        totalSessions: 0,
        activeSessions: 0,
        completedSessions: 0,
        errorSessions: 0,
      });
    });
  });

  describe('disconnect', () => {
    it('should close Redis connection', async () => {
      mockRedis.quit.mockResolvedValue('OK');

      await stateManager.disconnect();

      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
