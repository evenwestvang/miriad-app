/**
 * RuntimeConnectionManager Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createRuntimeConnectionManager, type RuntimeConnectionManager } from './runtime-connection-manager.js';
import { AgentStateManager } from '@cast/runtime';

// =============================================================================
// Mock WebSocket
// =============================================================================

class MockWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1; // OPEN

  sent: string[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  // Helper to simulate receiving a message
  receiveMessage(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage() {
  const runtimes = new Map<string, { id: string; spaceId: string; name: string; status: string; config: unknown }>();
  const channels = new Map<string, { id: string; spaceId: string; name: string }>();
  const rosterEntries = new Map<string, { runtimeId?: string; id?: string; lastHeartbeat?: string }>();

  return {
    getRuntime: vi.fn(async (id: string) => runtimes.get(id) ?? null),
    getRuntimeByName: vi.fn(async (spaceId: string, name: string) => {
      // Look up runtime by spaceId + name
      for (const runtime of runtimes.values()) {
        if (runtime.spaceId === spaceId && runtime.name === name) {
          return runtime;
        }
      }
      return null;
    }),
    createRuntime: vi.fn(async (input: { id: string; spaceId: string; name: string; type: string; status: string; config: unknown }) => {
      const runtime = { ...input };
      runtimes.set(input.id, runtime);
      return runtime;
    }),
    updateRuntime: vi.fn(async (id: string, update: Partial<{ name: string; status: string; config: unknown; lastSeenAt: string }>) => {
      const runtime = runtimes.get(id);
      if (runtime) {
        Object.assign(runtime, update);
      }
    }),
    updateConnectionRuntime: vi.fn(async () => {}),
    getAgentsByRuntime: vi.fn(async () => []),
    getChannelById: vi.fn(async (id: string) => channels.get(id) ?? null),
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      return rosterEntries.get(`${channelId}:${callsign}`) ?? null;
    }),
    updateRosterEntry: vi.fn(async () => {}),
    saveMessage: vi.fn(async () => ({ id: 'msg_1' })),
    saveCostRecord: vi.fn(async () => ({})),

    // Test helpers
    _setChannel: (id: string, spaceId: string, name: string) => {
      channels.set(id, { id, spaceId, name });
    },
    _setRosterEntry: (channelId: string, callsign: string, runtimeId?: string) => {
      rosterEntries.set(`${channelId}:${callsign}`, { runtimeId, id: `roster_${callsign}` });
    },
    _runtimes: runtimes,
  };
}

// =============================================================================
// Mock ConnectionManager
// =============================================================================

function createMockConnectionManager() {
  return {
    broadcast: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getChannelConnections: vi.fn(() => []),
    getConnection: vi.fn(),
    switchChannel: vi.fn(),
    getConnectionCount: vi.fn(() => 0),
    getChannelConnectionCount: vi.fn(() => 0),
    closeAll: vi.fn(),
  };
}

// =============================================================================
// Mock Server Auth Verifier
// =============================================================================

vi.mock('../handlers/runtime-auth.js', () => ({
  createServerAuthVerifier: () => async (header: string) => {
    if (header === 'Server valid_secret') {
      return { serverId: 'srv_123', spaceId: 'space_123' };
    }
    return null;
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('RuntimeConnectionManager', () => {
  let manager: RuntimeConnectionManager;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let mockConnectionManager: ReturnType<typeof createMockConnectionManager>;
  let agentStateManager: AgentStateManager;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockConnectionManager = createMockConnectionManager();
    agentStateManager = new AgentStateManager();

    manager = createRuntimeConnectionManager({
      storage: mockStorage as unknown as Parameters<typeof createRuntimeConnectionManager>[0]['storage'],
      connectionManager: mockConnectionManager as unknown as Parameters<typeof createRuntimeConnectionManager>[0]['connectionManager'],
      agentStateManager,
      requireAuth: false,
      pingIntervalMs: 60000, // Long interval for tests
    });
  });

  afterEach(() => {
    manager.closeAll();
  });

  describe('handleConnection', () => {
    it('should accept connection in dev mode (no auth)', async () => {
      const ws = new MockWebSocket();

      await manager.handleConnection(ws as unknown as WebSocket);

      // Should not be immediately closed
      expect(ws.readyState).toBe(ws.OPEN);
    });

    it('should reject connection when auth required but missing', async () => {
      const authManager = createRuntimeConnectionManager({
        storage: mockStorage as unknown as Parameters<typeof createRuntimeConnectionManager>[0]['storage'],
        connectionManager: mockConnectionManager as unknown as Parameters<typeof createRuntimeConnectionManager>[0]['connectionManager'],
        agentStateManager,
        requireAuth: true,
        pingIntervalMs: 60000,
      });

      const ws = new MockWebSocket();

      await authManager.handleConnection(ws as unknown as WebSocket);

      expect(ws.closeCode).toBe(4001);
      expect(ws.sent).toContainEqual(
        expect.stringContaining('AUTH_REQUIRED')
      );

      authManager.closeAll();
    });
  });

  describe('runtime_ready', () => {
    it('should register new runtime on runtime_ready', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
        machineInfo: { os: 'darwin', hostname: 'test-mac' },
      });

      // Wait for async handling
      await new Promise((r) => setTimeout(r, 50));

      // Should have created runtime
      expect(mockStorage.createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rt_001',
          spaceId: 'space_123',
          name: 'test-runtime',
          type: 'local',
          status: 'online',
        })
      );

      // Should have sent runtime_connected
      expect(ws.sent).toContainEqual(
        expect.stringContaining('runtime_connected')
      );

      // Should be tracked as online
      expect(manager.isRuntimeOnline('rt_001')).toBe(true);
    });

    it('should update existing runtime on reconnection', async () => {
      // Pre-populate runtime
      mockStorage._runtimes.set('rt_001', {
        id: 'rt_001',
        spaceId: 'space_123',
        name: 'old-name',
        status: 'offline',
        config: null,
      });

      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'new-name',
      });

      await new Promise((r) => setTimeout(r, 50));

      // Should have updated, not created
      expect(mockStorage.updateRuntime).toHaveBeenCalledWith(
        'rt_001',
        expect.objectContaining({
          name: 'new-name',
          status: 'online',
        })
      );
      expect(mockStorage.createRuntime).not.toHaveBeenCalled();
    });
  });

  describe('agent_checkin', () => {
    it('should update agent state on checkin', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // First register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Set up agent as activating
      const agentId = 'space_123:channel_1:fox';
      agentStateManager.handleActivate(agentId);
      expect(agentStateManager.getState(agentId)?.status).toBe('activating');

      // Send checkin
      ws.receiveMessage({
        type: 'agent_checkin',
        agentId,
      });
      await new Promise((r) => setTimeout(r, 50));

      // State should be online
      expect(agentStateManager.getState(agentId)?.status).toBe('online');

      // Should broadcast status
      expect(mockConnectionManager.broadcast).toHaveBeenCalledWith(
        'channel_1',
        expect.stringContaining('online')
      );
    });

    it('should reject checkin before runtime_ready', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Send checkin without runtime_ready first
      ws.receiveMessage({
        type: 'agent_checkin',
        agentId: 'space_123:channel_1:fox',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should get error
      expect(ws.sent).toContainEqual(
        expect.stringContaining('NOT_REGISTERED')
      );
    });
  });

  describe('frame', () => {
    it('should broadcast frame and update state to busy', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Set up agent as online
      const agentId = 'space_123:channel_1:fox';
      agentStateManager.handleActivate(agentId);
      agentStateManager.handleCheckin(agentId);
      expect(agentStateManager.getState(agentId)?.status).toBe('online');

      // Send non-idle frame (SetFrame requires i, t, and v)
      ws.receiveMessage({
        type: 'frame',
        agentId,
        frame: { i: 'msg_001', t: new Date().toISOString(), v: { type: 'agent', sender: 'fox', content: 'Hello' } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // State should be busy
      expect(agentStateManager.getState(agentId)?.status).toBe('busy');

      // Should broadcast
      expect(mockConnectionManager.broadcast).toHaveBeenCalledWith(
        'channel_1',
        expect.stringContaining('msg_001')
      );
    });

    it('should set state to online on idle frame', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Set up agent as busy
      const agentId = 'space_123:channel_1:fox';
      agentStateManager.handleActivate(agentId);
      agentStateManager.handleCheckin(agentId);
      agentStateManager.handleFrame(agentId, false); // busy
      expect(agentStateManager.getState(agentId)?.status).toBe('busy');

      // Send idle frame (SetFrame requires i, t, and v)
      ws.receiveMessage({
        type: 'frame',
        agentId,
        frame: { i: 'msg_002', t: new Date().toISOString(), v: { type: 'idle', sender: 'fox' } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // State should be online
      expect(agentStateManager.getState(agentId)?.status).toBe('online');
    });

    it('should persist SetFrame messages', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Set up channel
      mockStorage._setChannel('channel_1', 'space_123', 'test-channel');

      // Set up agent as online
      const agentId = 'space_123:channel_1:fox';
      agentStateManager.handleActivate(agentId);
      agentStateManager.handleCheckin(agentId);

      // Send frame (SetFrame requires i, t, and v)
      ws.receiveMessage({
        type: 'frame',
        agentId,
        frame: { i: 'msg_001', t: new Date().toISOString(), v: { type: 'agent', sender: 'fox', content: 'Hello' } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should save message
      expect(mockStorage.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg_001',
          channelId: 'channel_1',
          sender: 'fox',
          type: 'agent',
        })
      );
    });
  });

  describe('sendCommand', () => {
    it('should send command to connected runtime', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      ws.sent = []; // Clear previous messages

      // Send command
      const result = manager.sendCommand('rt_001', {
        type: 'activate',
        agentId: 'space_123:channel_1:fox',
        systemPrompt: 'You are fox',
        workspacePath: '/tmp/agents/fox',
      });

      expect(result).toBe(true);
      expect(ws.sent).toContainEqual(
        expect.stringContaining('activate')
      );
    });

    it('should return false for disconnected runtime', () => {
      const result = manager.sendCommand('rt_nonexistent', {
        type: 'ping',
        timestamp: new Date().toISOString(),
      });

      expect(result).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should mark runtime and agents offline on disconnect', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Set up agent as online with binding to this runtime
      const agentId = 'space_123:channel_1:fox';
      mockStorage._setRosterEntry('channel_1', 'fox', 'rt_001');
      agentStateManager.handleActivate(agentId);
      agentStateManager.handleCheckin(agentId);

      expect(manager.isRuntimeOnline('rt_001')).toBe(true);
      expect(agentStateManager.getState(agentId)?.status).toBe('online');

      // Disconnect
      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      // Runtime should be offline
      expect(manager.isRuntimeOnline('rt_001')).toBe(false);
      expect(mockStorage.updateRuntime).toHaveBeenCalledWith(
        'rt_001',
        expect.objectContaining({ status: 'offline' })
      );

      // Agent should be offline
      expect(agentStateManager.getState(agentId)?.status).toBe('offline');
    });
  });

  describe('pong', () => {
    it('should update lastPong on pong message', async () => {
      const ws = new MockWebSocket();
      await manager.handleConnection(ws as unknown as WebSocket);

      // Register runtime
      ws.receiveMessage({
        type: 'runtime_ready',
        runtimeId: 'rt_001',
        spaceId: 'space_123',
        name: 'test-runtime',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Send pong
      ws.receiveMessage({
        type: 'pong',
        timestamp: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Runtime should still be online (no disconnect due to staleness)
      expect(manager.isRuntimeOnline('rt_001')).toBe(true);
    });
  });
});
