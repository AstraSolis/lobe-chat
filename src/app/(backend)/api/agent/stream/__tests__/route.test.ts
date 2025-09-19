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
  });

  describe('Stream functionality with exact data verification', () => {
    it('should send connection event in exact SSE format', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&lastEventId=123',
      );

      const response = await GET(request);
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();

      // Collect all chunks
      const chunks = [];
      let readCount = 0;
      const maxReads = 1; // Only read connection event

      try {
        while (readCount < maxReads) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), 1000),
          );

          const result = (await Promise.race([
            readPromise,
            timeoutPromise,
          ])) as ReadableStreamReadResult<Uint8Array>;

          if (result.done) break;
          if (result.value) {
            const chunk =
              result.value instanceof Uint8Array
                ? decoder.decode(result.value)
                : String(result.value);
            chunks.push(chunk);
            readCount++;
          }
        }
      } catch (error) {
        // Timeout or error
      } finally {
        reader.releaseLock();
      }

      // Parse the connection event to get actual timestamp
      const connectionData = chunks[0].replace('data: ', '').replace('\n\n', '');
      const connectionEvent = JSON.parse(connectionData);

      // Verify exact stream format
      expect(chunks).toEqual([
        `data: {"lastEventId":"123","sessionId":"test-session","timestamp":${connectionEvent.timestamp},"type":"connected"}\n\n`,
      ]);
    });

    it('should verify getStreamHistory with exact historical events format', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=true&lastEventId=100',
      );

      // Mock getStreamHistory to return specific events
      const mockEvents = [
        {
          type: 'stream_end',
          timestamp: 300,
          sessionId: 'test-session',
          data: { messageId: 'msg3' },
        },
        {
          type: 'stream_chunk',
          timestamp: 250,
          sessionId: 'test-session',
          data: { content: 'world' },
        },
        {
          type: 'stream_start',
          timestamp: 150,
          sessionId: 'test-session',
          data: { messageId: 'msg1' },
        },
      ];
      mockStreamEventManager.getStreamHistory.mockResolvedValue(mockEvents);

      const response = await GET(request);
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();

      // Collect all chunks
      const chunks = [];
      let readCount = 0;
      const maxReads = 3; // connection + 2 filtered historical events (timestamp > 100)

      try {
        while (readCount < maxReads) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), 500),
          );

          const result = (await Promise.race([
            readPromise,
            timeoutPromise,
          ])) as ReadableStreamReadResult<Uint8Array>;

          if (result.done) break;
          if (result.value) {
            const chunk =
              result.value instanceof Uint8Array
                ? decoder.decode(result.value)
                : String(result.value);
            chunks.push(chunk);
            readCount++;
          }
        }
      } catch (error) {
        // Timeout or error
      } finally {
        reader.releaseLock();
      }

      // Parse the connection event to get actual timestamp
      const connectionData = chunks[0].replace('data: ', '').replace('\n\n', '');
      const connectionEvent = JSON.parse(connectionData);

      // Verify exact stream format - connection event + all historical events (all have timestamp > 100)
      expect(chunks).toEqual([
        `data: {"lastEventId":"100","sessionId":"test-session","timestamp":${connectionEvent.timestamp},"type":"connected"}\n\n`,
        `data: {"type":"stream_start","timestamp":150,"sessionId":"test-session","data":{"messageId":"msg1"}}\n\n`,
        `data: {"type":"stream_chunk","timestamp":250,"sessionId":"test-session","data":{"content":"world"}}\n\n`,
      ]);

      // Verify API calls
      expect(mockStreamEventManager.getStreamHistory).toHaveBeenCalledWith('test-session', 50);
    });

    it('should verify event filtering with exact format', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=true&lastEventId=200',
      );

      // Mock events where some should be filtered out
      const mockEvents = [
        {
          type: 'stream_end',
          timestamp: 300,
          sessionId: 'test-session',
          data: { messageId: 'msg3' },
        }, // Should be included (300 > 200)
        {
          type: 'stream_chunk',
          timestamp: 250,
          sessionId: 'test-session',
          data: { content: 'world' },
        }, // Should be included (250 > 200)
        {
          type: 'stream_chunk',
          timestamp: 200,
          sessionId: 'test-session',
          data: { content: 'hello' },
        }, // Should be excluded (200 = 200)
        {
          type: 'stream_start',
          timestamp: 150,
          sessionId: 'test-session',
          data: { messageId: 'msg1' },
        }, // Should be excluded (150 < 200)
      ];
      mockStreamEventManager.getStreamHistory.mockResolvedValue(mockEvents);

      const response = await GET(request);
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();

      // Collect all chunks
      const chunks = [];
      let readCount = 0;
      const maxReads = 3; // connection + 2 filtered events

      try {
        while (readCount < maxReads) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), 500),
          );

          const result = (await Promise.race([
            readPromise,
            timeoutPromise,
          ])) as ReadableStreamReadResult<Uint8Array>;

          if (result.done) break;
          if (result.value) {
            const chunk =
              result.value instanceof Uint8Array
                ? decoder.decode(result.value)
                : String(result.value);
            chunks.push(chunk);
            readCount++;
          }
        }
      } catch (error) {
        // Timeout or error
      } finally {
        reader.releaseLock();
      }

      // Parse the connection event to get actual timestamp
      const connectionData = chunks[0].replace('data: ', '').replace('\n\n', '');
      const connectionEvent = JSON.parse(connectionData);

      // Verify exact stream format - only events with timestamp > 200 are included
      expect(chunks).toEqual([
        `data: {"lastEventId":"200","sessionId":"test-session","timestamp":${connectionEvent.timestamp},"type":"connected"}\n\n`,
        `data: {"type":"stream_chunk","timestamp":250,"sessionId":"test-session","data":{"content":"world"}}\n\n`,
        `data: {"type":"stream_end","timestamp":300,"sessionId":"test-session","data":{"messageId":"msg3"}}\n\n`,
      ]);

      // Verify API calls
      expect(mockStreamEventManager.getStreamHistory).toHaveBeenCalledWith('test-session', 50);
    });

    it('should handle errors with exact error event format', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&includeHistory=true',
      );

      // Mock getStreamHistory to reject
      mockStreamEventManager.getStreamHistory.mockRejectedValue(
        new Error('Redis connection failed'),
      );

      const response = await GET(request);
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();

      // Collect all chunks
      const chunks = [];
      let readCount = 0;
      const maxReads = 2; // connection + error event

      try {
        while (readCount < maxReads) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), 500),
          );

          const result = (await Promise.race([
            readPromise,
            timeoutPromise,
          ])) as ReadableStreamReadResult<Uint8Array>;

          if (result.done) break;
          if (result.value) {
            const chunk =
              result.value instanceof Uint8Array
                ? decoder.decode(result.value)
                : String(result.value);
            chunks.push(chunk);
            readCount++;
          }
        }
      } catch (error) {
        // Timeout or error
      } finally {
        reader.releaseLock();
      }

      // Parse the connection event to get actual timestamp
      const connectionData = chunks[0].replace('data: ', '').replace('\n\n', '');
      const connectionEvent = JSON.parse(connectionData);

      // Parse the error event to get actual timestamp
      const errorData = chunks[1].replace('data: ', '').replace('\n\n', '');
      const errorEvent = JSON.parse(errorData);

      // Verify exact stream format - connection event + error event
      expect(chunks).toEqual([
        `data: {"lastEventId":"0","sessionId":"test-session","timestamp":${connectionEvent.timestamp},"type":"connected"}\n\n`,
        `data: {"data":{"error":"Redis connection failed","phase":"history_loading"},"sessionId":"test-session","timestamp":${errorEvent.timestamp},"type":"error"}\n\n`,
      ]);

      // Verify getStreamHistory was called
      expect(mockStreamEventManager.getStreamHistory).toHaveBeenCalledWith('test-session', 50);
    });

    it('should verify stream subscription with exact parameters', async () => {
      const request = new NextRequest(
        'https://test.com/api/agent/stream?sessionId=test-session&lastEventId=456',
      );

      mockStreamEventManager.subscribeStreamEvents.mockResolvedValue(undefined);

      const response = await GET(request);

      expect(response.status).toBe(200);

      // Verify exact parameter passing
      expect(mockStreamEventManager.subscribeStreamEvents).toHaveBeenCalledWith(
        'test-session',
        '456',
        expect.any(Function), // callback function
        expect.any(AbortSignal), // abort signal
      );

      // Verify the callback function structure
      const callArgs = mockStreamEventManager.subscribeStreamEvents.mock.calls[0];
      expect(callArgs).toHaveLength(4);
      expect(typeof callArgs[2]).toBe('function'); // callback
      expect(callArgs[3]).toBeInstanceOf(AbortSignal); // signal
    });

    it('should verify default parameters with exact values', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');

      mockStreamEventManager.subscribeStreamEvents.mockResolvedValue(undefined);

      const response = await GET(request);

      expect(response.status).toBe(200);

      // Verify default values are used
      expect(mockStreamEventManager.subscribeStreamEvents).toHaveBeenCalledWith(
        'test-session',
        '0', // default lastEventId
        expect.any(Function),
        expect.any(AbortSignal),
      );

      // Verify getStreamHistory is NOT called when includeHistory defaults to false
      expect(mockStreamEventManager.getStreamHistory).not.toHaveBeenCalled();
    });

    it('should verify SSE message structure with exact format specification', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=test-session');

      const response = await GET(request);
      const decoder = new TextDecoder();
      const reader = response.body!.getReader();

      // Collect all chunks
      const chunks = [];
      let readCount = 0;
      const maxReads = 1; // Only read connection event

      try {
        while (readCount < maxReads) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), 1000),
          );

          const result = (await Promise.race([
            readPromise,
            timeoutPromise,
          ])) as ReadableStreamReadResult<Uint8Array>;

          if (result.done) break;
          if (result.value) {
            const chunk =
              result.value instanceof Uint8Array
                ? decoder.decode(result.value)
                : String(result.value);
            chunks.push(chunk);
            readCount++;
          }
        }
      } catch (error) {
        // Timeout or error
      } finally {
        reader.releaseLock();
      }

      // Parse the connection event to get actual timestamp
      const connectionData = chunks[0].replace('data: ', '').replace('\n\n', '');
      const connectionEvent = JSON.parse(connectionData);

      // Verify exact stream format with default lastEventId
      expect(chunks).toEqual([
        `data: {"lastEventId":"0","sessionId":"test-session","timestamp":${connectionEvent.timestamp},"type":"connected"}\n\n`,
      ]);
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

    it('should handle invalid URL gracefully', async () => {
      const request = new NextRequest('https://test.com/api/agent/stream?sessionId=');

      const response = await GET(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('sessionId parameter is required');
    });
  });
});
