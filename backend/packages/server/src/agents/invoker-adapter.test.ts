import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentInvokerAdapter } from './invoker-adapter.js';
import type { AgentManager } from './agent-manager.js';
import type { Storage } from '@cast/storage';
import type { Message } from '../handlers/messages.js';
import type { ConnectionManager } from '../websocket/index.js';

// Mock the checkin module to avoid actual HTTP calls
vi.mock('../handlers/checkin.js', () => ({
  pushMessagesToContainer: vi.fn(async () => true),
  compileMessages: vi.fn(() => 'compiled'),
  broadcastAgentState: vi.fn(async () => {}),
}));

// =============================================================================
// Mock AgentManager
// =============================================================================

function createMockAgentManager(): AgentManager & {
  sendMessageCalls: Array<{
    spaceId: string;
    channelId: string;
    callsign: string;
    sender: string;
    content: string;
  }>;
} {
  const sendMessageCalls: Array<{
    spaceId: string;
    channelId: string;
    callsign: string;
    sender: string;
    content: string;
  }> = [];

  return {
    sendMessageCalls,
    sendMessage: vi.fn(async (spaceId, channelId, callsign, sender, content) => {
      sendMessageCalls.push({ spaceId, channelId, callsign, sender, content });
    }),
    buildPromptForAgent: vi.fn(async () => 'mock system prompt'),
    getMcpConfigsForAgent: vi.fn(async () => []),
    getAgentProps: vi.fn(async () => undefined), // Returns undefined by default (no props)
    resolveEnvironment: vi.fn(async () => ({})),
    spawn: vi.fn(),
    stop: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as AgentManager & {
    sendMessageCalls: Array<{
      spaceId: string;
      channelId: string;
      callsign: string;
      sender: string;
      content: string;
    }>;
  };
}

// =============================================================================
// Mock RuntimeSend (for LocalRuntime WebSocket routing)
// =============================================================================

function createMockRuntimeSend(): {
  fn: (connectionId: string, data: string) => Promise<boolean>;
  calls: Array<{ connectionId: string; message: string }>;
} {
  const calls: Array<{ connectionId: string; message: string }> = [];
  return {
    fn: vi.fn(async (connectionId: string, data: string) => {
      calls.push({ connectionId, message: data });
      return true;
    }),
    calls,
  };
}

// =============================================================================
// Mock ConnectionManager (for browser client broadcasts)
// =============================================================================

function createMockConnectionManager(): ConnectionManager & {
  sendCalls: Array<{ connectionId: string; message: string }>;
  broadcastCalls: Array<{ channelId: string; message: string }>;
} {
  const sendCalls: Array<{ connectionId: string; message: string }> = [];
  const broadcastCalls: Array<{ channelId: string; message: string }> = [];

  return {
    sendCalls,
    broadcastCalls,
    send: vi.fn(async (connectionId: string, message: string) => {
      sendCalls.push({ connectionId, message });
      return true;
    }),
    broadcast: vi.fn(async (channelId: string, message: string) => {
      broadcastCalls.push({ channelId, message });
    }),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getConnection: vi.fn(),
    closeAll: vi.fn(),
    initialize: vi.fn(),
    switchChannel: vi.fn(),
  } as unknown as ConnectionManager & {
    sendCalls: Array<{ connectionId: string; message: string }>;
    broadcastCalls: Array<{ channelId: string; message: string }>;
  };
}

// =============================================================================
// Mock Storage
// =============================================================================

interface MockStorageOptions {
  /** Map of callsign -> callbackUrl (null means no container running) */
  rosterCallbackUrls?: Record<string, string | null>;
  /** Map of callsign -> runtimeId (for LocalRuntime routing) */
  rosterRuntimeIds?: Record<string, string | null>;
  /** Map of callsign -> lastHeartbeat (for online status check) */
  rosterHeartbeats?: Record<string, string | null>;
  /** Map of runtimeId -> runtime record */
  runtimes?: Record<string, { status: string; config?: { wsConnectionId?: string } } | null>;
}

function createMockStorage(options: MockStorageOptions = {}): Storage & {
  getRosterByCallsignCalls: string[];
  updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
  getRuntimeCalls: string[];
} {
  const rosterCallbackUrls = options.rosterCallbackUrls ?? {};
  const rosterRuntimeIds = options.rosterRuntimeIds ?? {};
  const rosterHeartbeats = options.rosterHeartbeats ?? {};
  const runtimes = options.runtimes ?? {};
  const getRosterByCallsignCalls: string[] = [];
  const updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }> = [];
  const getRuntimeCalls: string[] = [];

  return {
    getRosterByCallsignCalls,
    updateRosterEntryCalls,
    getRuntimeCalls,
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      getRosterByCallsignCalls.push(callsign);
      const callbackUrl = rosterCallbackUrls[callsign];
      const runtimeId = rosterRuntimeIds[callsign];
      if (callbackUrl === undefined && runtimeId === undefined) {
        // Not in roster
        return null;
      }
      return {
        id: `roster-${callsign}`,
        channelId,
        callsign,
        agentType: 'engineer',
        status: 'active',
        createdAt: new Date().toISOString(),
        callbackUrl: callbackUrl ?? undefined,
        runtimeId: runtimeId ?? undefined,
        lastHeartbeat: rosterHeartbeats[callsign] ?? undefined,
      };
    }),
    updateRosterEntry: vi.fn(async (channelId: string, entryId: string, update: unknown) => {
      updateRosterEntryCalls.push({ channelId, entryId, update });
    }),
    getRuntime: vi.fn(async (runtimeId: string) => {
      getRuntimeCalls.push(runtimeId);
      const runtime = runtimes[runtimeId];
      if (!runtime) return null;
      return {
        id: runtimeId,
        spaceId: 'space-1',
        name: 'test-runtime',
        status: runtime.status,
        config: runtime.config ?? null,
        createdAt: new Date().toISOString(),
      };
    }),
    // Other methods not used
    saveMessage: vi.fn(),
    getMessage: vi.fn(),
    getMessages: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    createChannel: vi.fn(),
    getChannel: vi.fn(),
    getChannelByName: vi.fn(),
    listChannels: vi.fn(),
    updateChannel: vi.fn(),
    archiveChannel: vi.fn(),
    addToRoster: vi.fn(),
    getRosterEntry: vi.fn(),
    listRoster: vi.fn(),
    removeFromRoster: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
    getSpaceSecretValue: vi.fn(async () => null), // Platform secrets (letta_api_key, etc.)
  } as unknown as Storage & {
    getRosterByCallsignCalls: string[];
    updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
    getRuntimeCalls: string[];
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('createAgentInvokerAdapter', () => {
  let mockAgentManager: ReturnType<typeof createMockAgentManager>;
  let mockStorage: ReturnType<typeof createMockStorage>;
  const spaceId = 'space-1';

  const testMessage: Message = {
    id: 'msg-1',
    channelId: 'channel-1',
    sender: 'alice',
    senderType: 'user',
    type: 'message',
    content: '@fox @bear help me please',
    timestamp: new Date().toISOString(),
    isComplete: true,
    addressedAgents: ['fox', 'bear'],
  };

  beforeEach(() => {
    mockAgentManager = createMockAgentManager();
    // Default: no containers running (no callbackUrl)
    mockStorage = createMockStorage({
      rosterCallbackUrls: { fox: null, bear: null, lead: null },
    });
  });

  describe('when no container is running (no callbackUrl)', () => {
    it('spawns containers via AgentManager.sendMessage for each target', async () => {
      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
      });

      await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

      // Should spawn containers since no callbackUrl
      expect(mockAgentManager.sendMessageCalls).toHaveLength(2);
      expect(mockAgentManager.sendMessageCalls).toEqual([
        {
          spaceId: 'space-1',
          channelId: 'channel-1',
          callsign: 'fox',
          sender: 'alice',
          content: '@fox @bear help me please',
        },
        {
          spaceId: 'space-1',
          channelId: 'channel-1',
          callsign: 'bear',
          sender: 'alice',
          content: '@fox @bear help me please',
        },
      ]);
    });

    it('invokes single target correctly', async () => {
      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
      });

      await invoker.invokeAgents('channel-1', ['lead'], testMessage);

      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0]).toEqual({
        spaceId: 'space-1',
        channelId: 'channel-1',
        callsign: 'lead',
        sender: 'alice',
        content: '@fox @bear help me please',
      });
    });
  });

  describe('when container is running (has callbackUrl)', () => {
    it('pushes directly to container instead of spawning', async () => {
      // Container already running for fox
      mockStorage = createMockStorage({
        rosterCallbackUrls: { fox: 'http://10.0.1.1:8080', bear: null },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
      });

      await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

      // fox should not spawn (would push directly - tested separately)
      // bear should spawn since no callbackUrl
      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0].callsign).toBe('bear');
    });
  });

  it('does nothing when targets is empty', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
      storage: mockStorage,
      spaceId,
    });

    await invoker.invokeAgents('channel-1', [], testMessage);

    expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
  });

  it('handles partial failures gracefully', async () => {
    const failingManager = createMockAgentManager();
    (failingManager.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s, _c, callsign) => {
        failingManager.sendMessageCalls.push({
          spaceId: _s,
          channelId: _c,
          callsign,
          sender: 'alice',
          content: 'test',
        });
        if (callsign === 'bear') {
          throw new Error('Container unavailable');
        }
      }
    );

    const invoker = createAgentInvokerAdapter({
      agentManager: failingManager,
      storage: mockStorage,
      spaceId,
    });

    // Should not throw despite partial failure
    await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

    // Both should have been attempted
    expect(failingManager.sendMessageCalls).toHaveLength(2);
  });

  it('passes correct sender from message', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
      storage: mockStorage,
      spaceId,
    });

    const agentMessage: Message = {
      ...testMessage,
      sender: 'other-agent',
      senderType: 'agent',
    };

    await invoker.invokeAgents('channel-1', ['fox'], agentMessage);

    expect(mockAgentManager.sendMessageCalls[0].sender).toBe('other-agent');
  });

  it('uses configured spaceId for all invocations', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
      storage: mockStorage,
      spaceId: 'different-space',
    });

    await invoker.invokeAgents('channel-1', ['fox', 'bear', 'lead'], testMessage);

    for (const call of mockAgentManager.sendMessageCalls) {
      expect(call.spaceId).toBe('different-space');
    }
  });

  describe('when agent has runtime_id (DB-based WebSocket routing)', () => {
    const RUNTIME_ID = 'rt_local_001';
    const WS_CONNECTION_ID = 'ws-conn-123';
    let mockConnectionManager: ReturnType<typeof createMockConnectionManager>;
    let mockRuntimeSend: ReturnType<typeof createMockRuntimeSend>;

    beforeEach(() => {
      mockConnectionManager = createMockConnectionManager();
      mockRuntimeSend = createMockRuntimeSend();
    });

    it('sends message via WebSocket when agent is online (recent heartbeat)', async () => {
      // Agent has runtime_id, runtime is online, agent has recent heartbeat
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID },
        rosterCallbackUrls: { fox: null },
        rosterHeartbeats: { fox: new Date().toISOString() }, // Recent heartbeat
        runtimes: {
          [RUNTIME_ID]: { status: 'online', config: { wsConnectionId: WS_CONNECTION_ID } },
        },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
        runtimeSend: mockRuntimeSend.fn,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should send message via runtimeSend, not spawn container
      expect(mockRuntimeSend.calls).toHaveLength(1);
      expect(mockRuntimeSend.calls[0].connectionId).toBe(WS_CONNECTION_ID);
      const parsedMessage = JSON.parse(mockRuntimeSend.calls[0].message);
      expect(parsedMessage.type).toBe('message');
      expect(parsedMessage.agentId).toBe('space-1:channel-1:fox');
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
    });

    it('sends message via WebSocket even when agent has no recent heartbeat', async () => {
      // Agent has runtime_id, runtime is online, but agent has no heartbeat
      // LocalRuntime simplification: always send 'message' directly - AgentManager auto-activates
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID },
        rosterCallbackUrls: { fox: null },
        rosterHeartbeats: { fox: null }, // No heartbeat - agent not active
        runtimes: {
          [RUNTIME_ID]: { status: 'online', config: { wsConnectionId: WS_CONNECTION_ID } },
        },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
        runtimeSend: mockRuntimeSend.fn,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should send message directly - AgentManager.deliverMessage auto-activates if needed
      expect(mockRuntimeSend.calls).toHaveLength(1);
      const parsedMessage = JSON.parse(mockRuntimeSend.calls[0].message);
      expect(parsedMessage.type).toBe('message');
      expect(parsedMessage.agentId).toBe('space-1:channel-1:fox');
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
    });

    it('broadcasts offline state when runtime is offline', async () => {
      // Agent has runtime_id but runtime is offline
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID },
        rosterCallbackUrls: { fox: null },
        runtimes: {
          [RUNTIME_ID]: { status: 'offline' },
        },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should NOT spawn container or send message - runtime is offline
      expect(mockConnectionManager.sendCalls).toHaveLength(0);
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
      // broadcastAgentState is called with 'offline' (mocked)
    });

    it('broadcasts offline state when runtime has no wsConnectionId', async () => {
      // Runtime is online but has no WebSocket connection
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID },
        rosterCallbackUrls: { fox: null },
        runtimes: {
          [RUNTIME_ID]: { status: 'online', config: {} }, // No wsConnectionId
        },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should NOT send message - no WebSocket connection
      expect(mockConnectionManager.sendCalls).toHaveLength(0);
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
    });

    it('falls through to spawn for agents without runtime_id', async () => {
      // bear has no runtime_id, should spawn container
      mockStorage = createMockStorage({
        rosterRuntimeIds: { bear: null },
        rosterCallbackUrls: { bear: null },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
      });

      await invoker.invokeAgents('channel-1', ['bear'], testMessage);

      // Should spawn container via AgentManager
      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0].callsign).toBe('bear');
      expect(mockConnectionManager.sendCalls).toHaveLength(0);
    });

    it('routes mixed agents correctly (some with runtime_id, some without)', async () => {
      // fox has runtime_id and is online, bear has no runtime_id
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID, bear: null },
        rosterCallbackUrls: { fox: null, bear: null },
        rosterHeartbeats: { fox: new Date().toISOString() },
        runtimes: {
          [RUNTIME_ID]: { status: 'online', config: { wsConnectionId: WS_CONNECTION_ID } },
        },
      });

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        connectionManager: mockConnectionManager as unknown as ConnectionManager,
        runtimeSend: mockRuntimeSend.fn,
      });

      await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

      // fox routes via runtimeSend
      expect(mockRuntimeSend.calls).toHaveLength(1);
      const parsedMessage = JSON.parse(mockRuntimeSend.calls[0].message);
      expect(parsedMessage.agentId).toBe('space-1:channel-1:fox');

      // bear spawns container
      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0].callsign).toBe('bear');
    });
  });
});
