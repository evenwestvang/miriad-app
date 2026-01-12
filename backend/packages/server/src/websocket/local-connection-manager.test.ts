import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createLocalConnectionManager, type LocalConnectionManager } from './local-connection-manager.js';
import { tymbal } from '@cast/core';
import type { Storage } from '@cast/storage';

// Mock Storage instance for testing
// LocalConnectionManager uses storage for connection persistence, but the actual
// WebSocket handling and in-memory connection tracking is what we're testing here.
const createMockStorage = (): Storage => ({
  // Connection operations (used by PostgresConnectionManager internally)
  saveConnection: vi.fn(async () => {}),
  getConnection: vi.fn(async () => null),
  updateConnectionChannel: vi.fn(async () => {}),
  deleteConnection: vi.fn(async () => {}),
  getConnectionsByChannel: vi.fn(async () => []),

  // Other storage operations (not used by connection manager, but needed for interface)
  saveMessage: vi.fn(async () => ({} as never)),
  getMessage: vi.fn(async () => null),
  getMessages: vi.fn(async () => []),
  getMessagesByChannelId: vi.fn(async () => []),
  updateMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  createUser: vi.fn(async () => ({} as never)),
  getUser: vi.fn(async () => null),
  getUserByExternalId: vi.fn(async () => null),
  createSpace: vi.fn(async () => ({} as never)),
  getSpace: vi.fn(async () => null),
  getSpacesByOwner: vi.fn(async () => []),
  listSpacesWithOwners: vi.fn(async () => []),
  createChannel: vi.fn(async () => ({} as never)),
  getChannel: vi.fn(async () => null),
  getChannelById: vi.fn(async () => null),
  getChannelByName: vi.fn(async () => null),
  resolveChannel: vi.fn(async () => null),
  getChannelWithRoster: vi.fn(async () => null),
  resolveChannelWithRoster: vi.fn(async () => null),
  listChannels: vi.fn(async () => []),
  updateChannel: vi.fn(async () => {}),
  archiveChannel: vi.fn(async () => {}),
  addToRoster: vi.fn(async () => ({} as never)),
  getRosterEntry: vi.fn(async () => null),
  getRosterByCallsign: vi.fn(async () => null),
  listRoster: vi.fn(async () => []),
  listArchivedRoster: vi.fn(async () => []),
  updateRosterEntry: vi.fn(async () => {}),
  removeFromRoster: vi.fn(async () => {}),
  createArtifact: vi.fn(async () => ({} as never)),
  getArtifact: vi.fn(async () => null),
  updateArtifactWithCAS: vi.fn(async () => ({ success: true })),
  editArtifact: vi.fn(async () => ({} as never)),
  archiveArtifact: vi.fn(async () => ({} as never)),
  archiveArtifactRecursive: vi.fn(async () => ({ archived: [] })),
  listArtifacts: vi.fn(async () => []),
  globArtifacts: vi.fn(async () => []),
  checkpointArtifact: vi.fn(async () => ({} as never)),
  getArtifactVersion: vi.fn(async () => null),
  listArtifactVersions: vi.fn(async () => []),
  diffArtifactVersions: vi.fn(async () => ''),
  setSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  getSecretValue: vi.fn(async () => null),
  getSecretMetadata: vi.fn(async () => null),
  saveLocalAgentServer: vi.fn(async () => ({} as never)),
  getLocalAgentServer: vi.fn(async () => null),
  getLocalAgentServerBySecret: vi.fn(async () => null),
  getLocalAgentServersByUser: vi.fn(async () => []),
  revokeLocalAgentServer: vi.fn(async () => false),
  saveBootstrapToken: vi.fn(async () => ({} as never)),
  getBootstrapToken: vi.fn(async () => null),
  consumeBootstrapToken: vi.fn(async () => false),
  cleanupExpiredBootstrapTokens: vi.fn(async () => 0),
  saveCostRecord: vi.fn(async () => ({} as never)),
  getChannelCostTally: vi.fn(async () => []),
  initialize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
});

// Mock WebSocket
function createMockWebSocket(readyState = WebSocket.OPEN): WebSocket {
  const handlers: Record<string, Function[]> = {};

  const ws = {
    readyState,
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

describe('LocalConnectionManager', () => {
  let manager: LocalConnectionManager;
  let mockStorage: Storage;

  beforeEach(async () => {
    mockStorage = createMockStorage();
    manager = createLocalConnectionManager({
      storage: mockStorage,
    });
    await manager.initialize();
  });

  afterEach(() => {
    manager.closeAll();
  });

  describe('addConnection', () => {
    it('adds a connection and returns info', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      expect(info.connectionId).toMatch(/^conn_/);
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

    it('sets up WebSocket event handlers', () => {
      const ws = createMockWebSocket();
      manager.addConnection(ws, 'channel-1');

      expect(ws.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(ws.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(ws.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('removeConnection', () => {
    it('removes connection from storage', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      manager.removeConnection(info.connectionId);

      expect(manager.getConnection(info.connectionId)).toBeUndefined();
      expect(manager.getChannelConnectionCount('channel-1')).toBe(0);
    });

    it('closes WebSocket if open', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      manager.removeConnection(info.connectionId);

      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('switchChannel', () => {
    it('moves connection to new channel', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      const updated = manager.switchChannel(info.connectionId, 'channel-2');

      expect(updated?.channelId).toBe('channel-2');
      expect(manager.getChannelConnectionCount('channel-1')).toBe(0);
      expect(manager.getChannelConnectionCount('channel-2')).toBe(1);
    });

    it('returns undefined for unknown connection', () => {
      const result = manager.switchChannel('unknown', 'channel-2');
      expect(result).toBeUndefined();
    });

    it('does nothing if already in target channel', () => {
      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      const result = manager.switchChannel(info.connectionId, 'channel-1');

      expect(result?.channelId).toBe('channel-1');
      expect(manager.getChannelConnectionCount('channel-1')).toBe(1);
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
      const ws2 = createMockWebSocket(WebSocket.CLOSED);

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
      await manager.send(info.connectionId, frame);

      expect(ws.send).toHaveBeenCalledWith(frame, expect.any(Function));
    });

    it('throws for unknown connection', async () => {
      await expect(manager.send('unknown', 'frame')).rejects.toThrow('not found or not open');
    });

    it('throws for closed connection', async () => {
      const ws = createMockWebSocket(WebSocket.CLOSED);
      const info = manager.addConnection(ws, 'channel-1');

      await expect(manager.send(info.connectionId, 'frame')).rejects.toThrow('not found or not open');
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

      manager.removeConnection(info.connectionId);
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
      manager = createLocalConnectionManager({
        storage: createMockStorage(),
        onClose,
      });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate close event
      (ws as any)._emit('close');

      expect(onClose).toHaveBeenCalledWith(info);
    });

    it('calls onError when connection errors', () => {
      const onError = vi.fn();
      manager = createLocalConnectionManager({
        storage: createMockStorage(),
        onError,
      });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      const error = new Error('test error');
      (ws as any)._emit('error', error);

      expect(onError).toHaveBeenCalledWith(info, error);
    });

    it('calls onSyncRequest for sync frames', async () => {
      const onSyncRequest = vi.fn();
      manager = createLocalConnectionManager({
        storage: createMockStorage(),
        onSyncRequest,
      });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate sync request message
      const syncFrame = tymbal.sync('2026-01-04T10:00:00.000Z');
      (ws as any)._emit('message', Buffer.from(syncFrame));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

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
      manager = createLocalConnectionManager({
        storage: createMockStorage(),
        onFrame,
      });

      const ws = createMockWebSocket();
      const info = manager.addConnection(ws, 'channel-1');

      // Simulate append frame message
      const appendFrame = tymbal.append('01J001', 'Hello');
      (ws as any)._emit('message', Buffer.from(appendFrame));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onFrame).toHaveBeenCalledWith(
        info,
        expect.objectContaining({ i: '01J001', a: 'Hello' })
      );
    });

    it('ignores invalid frames', async () => {
      const onFrame = vi.fn();
      manager = createLocalConnectionManager({
        storage: createMockStorage(),
        onFrame,
      });

      const ws = createMockWebSocket();
      manager.addConnection(ws, 'channel-1');

      // Simulate invalid message
      (ws as any)._emit('message', Buffer.from('invalid json'));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onFrame).not.toHaveBeenCalled();
    });
  });
});
