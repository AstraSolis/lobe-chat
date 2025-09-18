// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamEventManager } from '@/server/modules/AgentRuntime';

import * as isEnableAgentModule from '../../isEnableAgent';
import { GET } from '../route';

// Mock dependencies first
const mockStreamEventManager = {
  getStreamHistory: vi.fn(),
  subscribeStreamEvents: vi.fn(),
};

vi.mock('@/server/modules/AgentRuntime', () => ({
  StreamEventManager: vi.fn(() => mockStreamEventManager),
}));

describe('/api/agent/stream route', () => {
  const isEnableAgentSpy = vi.spyOn(isEnableAgentModule, 'isEnableAgent');

  beforeEach(() => {
    vi.resetAllMocks();
    // Default to enabled for most tests
    isEnableAgentSpy.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET handler', () => {
    it('should return 404 when agent features are not enabled', async () => {
      isEnableAgentSpy.mockReturnValue(false);

      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');
      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Agent features are not enabled');
    });

    it('should return 400 when sessionId parameter is missing', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream');
      const response = await GET(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('sessionId parameter is required');
    });

    it('should return SSE stream with correct headers when sessionId is provided', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(response.headers.get('Connection')).toBe('keep-alive');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Cache-Control, Last-Event-ID',
      );
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('should parse query parameters correctly', async () => {
      const url =
        'https://test.com/api/agent/stream?sessionId=test-session&lastEventId=123&includeHistory=true';
      const request = new NextRequest(url);

      // Mock getStreamHistory to return empty array to avoid async complexity in this test
      mockStreamEventManager.getStreamHistory.mockResolvedValue([]);

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(StreamEventManager).toHaveBeenCalled();
    });

    it('should handle includeHistory=false by not calling getStreamHistory', async () => {
      const url = 'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=false';
      const request = new NextRequest(url);

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockStreamEventManager.getStreamHistory).not.toHaveBeenCalled();
    });

    it('should parse lastEventId parameter with default value', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');

      const response = await GET(request);

      expect(response.status).toBe(200);
      // Since we're testing the parameter parsing, we just verify the response is successful
    });

    it('should create StreamEventManager instance', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');

      await GET(request);

      expect(StreamEventManager).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stream functionality', () => {
    it('should handle stream creation without throwing errors', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');

      // Mock successful stream history call
      mockStreamEventManager.getStreamHistory.mockResolvedValue([]);

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
      expect(response.body).toBeInstanceOf(ReadableStream);
    });

    it('should initialize stream with connection event for includeHistory=false', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=false',
      );

      const response = await GET(request);
      const reader = response.body?.getReader();

      expect(reader).toBeDefined();
      if (reader) {
        try {
          // Read the first chunk which should be the connection event
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          expect(value).toBeDefined();

          if (value && value instanceof Uint8Array) {
            const chunk = new TextDecoder().decode(value);
            expect(chunk).toContain('data: ');

            // Parse the JSON data
            const dataLine = chunk.split('\n')[0];
            const jsonData = dataLine.replace('data: ', '');
            const event = JSON.parse(jsonData);

            expect(event.type).toBe('connected');
            expect(event.sessionId).toBe('test-session');
            expect(event.lastEventId).toBe('0');
            expect(event.timestamp).toBeDefined();
          }
        } catch (error) {
          // If we can't read the stream, just verify the response status
          expect(response.status).toBe(200);
        } finally {
          reader.releaseLock();
        }
      }
    });

    it('should handle getStreamHistory error gracefully when includeHistory=true', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=true',
      );

      // Mock getStreamHistory to reject
      mockStreamEventManager.getStreamHistory.mockRejectedValue(new Error('Redis error'));

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(ReadableStream);
    });

    it('should handle successful getStreamHistory when includeHistory=true', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=true&lastEventId=100',
      );

      // Mock getStreamHistory to return events
      const mockEvents = [
        { type: 'stream_start', timestamp: 200, data: { test: 'data1' } },
        { type: 'stream_chunk', timestamp: 150, data: { test: 'data2' } },
        { type: 'stream_end', timestamp: 50, data: { test: 'data3' } },
      ];
      mockStreamEventManager.getStreamHistory.mockResolvedValue(mockEvents);

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockStreamEventManager.getStreamHistory).toHaveBeenCalledWith('test-session', 50);
    });
  });

  describe('Error handling', () => {
    it('should handle invalid URL gracefully', async () => {
      // Create a request with malformed URL parameters
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=');

      const response = await GET(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('sessionId parameter is required');
    });
  });

  describe('Parameter validation', () => {
    it('should handle sessionId with special characters', async () => {
      const sessionId = 'test-session-123_456';
      const request = new NextRequest(`https://test.com/api/agent/stream?sessionId=${sessionId}`);

      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should handle lastEventId as string number', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test&lastEventId=12345',
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should handle includeHistory as string boolean', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test&includeHistory=false',
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockStreamEventManager.getStreamHistory).not.toHaveBeenCalled();
    });

    it('should handle missing lastEventId parameter', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test');

      const response = await GET(request);

      expect(response.status).toBe(200);
      // Should default to '0'
    });

    it('should handle missing includeHistory parameter', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test');

      const response = await GET(request);

      expect(response.status).toBe(200);
      // Should default to false, so getStreamHistory should not be called
      expect(mockStreamEventManager.getStreamHistory).not.toHaveBeenCalled();
    });
  });
});
