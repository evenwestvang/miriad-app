import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createConnectionManager, createChannelBroadcaster } from './connection-manager.js';
import { tymbal } from '@cast/core';

// Mock WebSocket
function createMockWebSocket(): WebSocket {
  const handlers: Record<string, Function[]> = {};

  const ws = {
    readyState: WebSocket.OPEN,
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    send: vi.fn((data: string, callback?: (err?: Error) => void) => {
      if (callback) callback();
    }),
    close: vi.fn(),
    // Helper to emit events in tests
    _emit: (event: string, ...args: unknown[]) => {
      const eventHandlers = handlers[event] || [];
      for (const handler of eventHandlers) {
        handler(...args);
      }
    },
  };

  return ws as unknown as WebSocket;
}

describe('ConnectionManager', () => {
  let manager: ReturnType<typeof createConnectionManager>;

  beforeEach(() => {
    manager = createConnectionManager();
  });

  afterEach(() => {
    manager.closeAll();
  });

  describe('addConnection', () => {
    it('adds a connection and returns info', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      expect(info.id).toMatch(/^conn_/);
      expect(info.channelId).toBe('channel-1');
      expect(info.ws).toBe(ws);
      expect(info.connectedAt).toBeInstanceOf(Date);
    });

    it('stores optional agent info', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1', {
        agentCallsign: 'fox',
        containerId: 'container-123',
      });

      expect(info.agentCallsign).toBe('fox');
      expect(info.containerId).toBe('container-123');
    });

    it('registers connection in channel', () => {
      const ws = createMockWebSocket();
      manager.addConnection(ws, 'channel-1');

      expect(manager.getChannelConnectionCount('channel-1')).toBe(1);
    });
  });

  describe('removeConnection', () => {
    it('removes connection from storage', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      manager.removeConnection(info.id);

      expect(manager.getConnection(info.id)).toBeUndefined();
      expect(manager.getChannelConnectionCount('channel-1')).toBe(0);
    });

    it('closes WebSocket if open', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      manager.removeConnection(info.id);

      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('getChannelConnections', () => {
    it('returns all connections in channel', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      manager.addConnection(ws1, 'channel-1');
      manager.addConnection(ws2, 'channel-1');
      manager.addConnection(ws3, 'channel-2');

      const ch1Connections = manager.getChannelConnections('channel-1');
      const ch2Connections = manager.getChannelConnections('channel-2');

      expect(ch1Connections).toHaveLength(2);
      expect(ch2Connections).toHaveLength(1);
    });

    it('returns empty array for unknown channel', () => {
      const connections = manager.getChannelConnections('unknown');
      expect(connections).toEqual([]);
    });
  });

  describe('broadcast', () => {
    it('sends frame to all connections in channel', async () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      manager.addConnection(ws1, 'channel-1');
      manager.addConnection(ws2, 'channel-1');
      manager.addConnection(ws3, 'channel-2');

      const frame = tymbal.append('01J001', 'Hello');
      await manager.broadcast('channel-1', frame);

      expect(ws1.send).toHaveBeenCalledWith(frame, expect.any(Function));
      expect(ws2.send).toHaveBeenCalledWith(frame, expect.any(Function));
      expect(ws3.send).not.toHaveBeenCalled();
    });

    it('skips closed connections', async () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      (ws2 as any).readyState = WebSocket.CLOSED;

      manager.addConnection(ws1, 'channel-1');
      manager.addConnection(ws2, 'channel-1');

      const frame = tymbal.append('01J001', 'Hello');
      await manager.broadcast('channel-1', frame);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('does nothing for empty channel', async () => {
      await expect(manager.broadcast('unknown', 'frame')).resolves.toBeUndefined();
    });
  });

  describe('send', () => {
    it('sends frame to specific connection', async () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      const frame = tymbal.set('01J001', { content: 'test' });
      await manager.send(info.id, frame);

      expect(ws.send).toHaveBeenCalledWith(frame, expect.any(Function));
    });

    it('throws for unknown connection', async () => {
      await expect(manager.send('unknown', 'frame')).rejects.toThrow('not found or not open');
    });

    it('throws for closed connection', async () => {
      const ws = createMockWebSocket();
      (ws as any).readyState = WebSocket.CLOSED;
      const info = manager.addConnection(ws, 'channel-1');

      await expect(manager.send(info.id, 'frame')).rejects.toThrow('not found or not open');
    });
  });

  describe('connection counts', () => {
    it('tracks total connections', () => {
      expect(manager.getConnectionCount()).toBe(0);

      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.addConnection(ws1, 'channel-1');
      expect(manager.getConnectionCount()).toBe(1);

      const info = manager.addConnection(ws2, 'channel-2');
      expect(manager.getConnectionCount()).toBe(2);

      manager.removeConnection(info.id);
      expect(manager.getConnectionCount()).toBe(1);
    });

    it('tracks channel connections', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.addConnection(ws1, 'channel-1');
      manager.addConnection(ws2, 'channel-1');

      expect(manager.getChannelConnectionCount('channel-1')).toBe(2);
      expect(manager.getChannelConnectionCount('channel-2')).toBe(0);
    });
  });

  describe('closeAll', () => {
    it('closes all connections', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.addConnection(ws1, 'channel-1');
      manager.addConnection(ws2, 'channel-2');

      manager.closeAll();

      expect(ws1.close).toHaveBeenCalled();
      expect(ws2.close).toHaveBeenCalled();
      expect(manager.getConnectionCount()).toBe(0);
    });
  });

  describe('event handlers', () => {
    it('calls onClose when connection closes', () => {
      const onClose = vi.fn();
      manager = createConnectionManager({ onClose });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate close event
      (ws as any)._emit('close');

      expect(onClose).toHaveBeenCalledWith(info);
    });

    it('calls onError when connection errors', () => {
      const onError = vi.fn();
      manager = createConnectionManager({ onError });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      const error = new Error('test error');
      (ws as any)._emit('error', error);

      expect(onError).toHaveBeenCalledWith(info, error);
    });

    it('calls onSyncRequest for sync frames', async () => {
      const onSyncRequest = vi.fn();
      manager = createConnectionManager({ onSyncRequest });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate sync request message
      const syncFrame = tymbal.sync('2026-01-04T10:00:00.000Z');
      (ws as any)._emit('message', Buffer.from(syncFrame));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 0));

      // New signature: (connection, channelId, since, before, limit)
      expect(onSyncRequest).toHaveBeenCalledWith(
        info,
        'channel-1',
        '2026-01-04T10:00:00.000Z',
        undefined,
        undefined
      );
    });

    it('calls onFrame for other frames', async () => {
      const onFrame = vi.fn();
      manager = createConnectionManager({ onFrame });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate append frame message
      const appendFrame = tymbal.append('01J001', 'Hello');
      (ws as any)._emit('message', Buffer.from(appendFrame));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onFrame).toHaveBeenCalledWith(
        info,
        expect.objectContaining({ i: '01J001', a: 'Hello' })
      );
    });

    it('ignores invalid frames', async () => {
      const onFrame = vi.fn();
      manager = createConnectionManager({ onFrame });

      const ws = createMockWebSocket();
      manager.addConnection(ws, 'channel-1');

      // Simulate invalid message
      (ws as any)._emit('message', Buffer.from('invalid json'));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onFrame).not.toHaveBeenCalled();
    });
  });

  describe('createChannelBroadcaster', () => {
    it('creates a broadcast function for a channel', async () => {
      const ws = createMockWebSocket();
      manager.addConnection(ws, 'channel-1');

      const broadcast = createChannelBroadcaster(manager, 'channel-1');
      const frame = tymbal.append('01J001', 'test');

      await broadcast(frame);

      expect(ws.send).toHaveBeenCalledWith(frame, expect.any(Function));
    });
  });
});
