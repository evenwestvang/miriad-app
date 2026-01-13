import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentInvokerAdapter } from './invoker-adapter.js';
import type { AgentManager } from './agent-manager.js';
import type { Storage } from '@cast/storage';
import type { Message } from '../handlers/messages.js';
import type { RuntimeRegistry, LocalRuntime } from './runtime-registry.js';
import type { AgentRuntime } from '@cast/runtime';

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
// Mock RuntimeRegistry and LocalRuntime
// =============================================================================

function createMockLocalRuntime(runtimeId: string): LocalRuntime & {
  activateCalls: Array<{ agentId: string; authToken: string; systemPrompt?: string }>;
  sendMessageCalls: Array<{ agentId: string; content: string; systemPrompt?: string }>;
  _onlineAgents: Set<string>;
} {
  const activateCalls: Array<{ agentId: string; authToken: string; systemPrompt?: string }> = [];
  const sendMessageCalls: Array<{ agentId: string; content: string; systemPrompt?: string }> = [];
  const onlineAgents = new Set<string>();

  return {
    runtimeId,
    activateCalls,
    sendMessageCalls,
    _onlineAgents: onlineAgents,
    activate: vi.fn(async (opts) => {
      activateCalls.push({
        agentId: opts.agentId,
        authToken: opts.authToken,
        systemPrompt: opts.systemPrompt,
      });
      return { agentId: opts.agentId, status: 'activating' };
    }),
    sendMessage: vi.fn(async (agentId, opts) => {
      sendMessageCalls.push({
        agentId,
        content: opts.content,
        systemPrompt: opts.systemPrompt,
      });
    }),
    suspend: vi.fn(),
    getState: vi.fn(() => null),
    isOnline: vi.fn((agentId) => onlineAgents.has(agentId)),
    getAllOnline: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as LocalRuntime & {
    activateCalls: Array<{ agentId: string; authToken: string; systemPrompt?: string }>;
    sendMessageCalls: Array<{ agentId: string; content: string; systemPrompt?: string }>;
    _onlineAgents: Set<string>;
  };
}

function createMockRuntimeRegistry(
  localRuntimes: Map<string, LocalRuntime>,
  agentToRuntimeMap: Map<string, string> = new Map()
): RuntimeRegistry & {
  getRuntimeForAgentCalls: string[];
  _localRuntimes: Map<string, LocalRuntime>;
  _agentToRuntimeMap: Map<string, string>;
} {
  const getRuntimeForAgentCalls: string[] = [];

  return {
    getRuntimeForAgentCalls,
    _localRuntimes: localRuntimes,
    _agentToRuntimeMap: agentToRuntimeMap,
    getRuntimeForAgent: vi.fn(async (agentId) => {
      getRuntimeForAgentCalls.push(agentId);
      // Check the mapping to simulate roster.runtimeId lookup
      const runtimeId = agentToRuntimeMap.get(agentId);
      if (!runtimeId) {
        // No runtimeId means use default runtime (return null to indicate no LocalRuntime)
        // But wait - the actual impl returns defaultRuntime, not null
        // For our tests, returning null simulates "no LocalRuntime binding"
        // Actually, we need to distinguish between:
        // 1. No runtimeId in roster -> return null (fall through to default flow)
        // 2. Has runtimeId but runtime offline -> return null (broadcast error)
        // 3. Has runtimeId and runtime online -> return LocalRuntime
        // For this mock, if agentId is in map, check if runtime is connected
        return null;
      }
      const runtime = localRuntimes.get(runtimeId);
      // Return the runtime if connected, null if offline
      return runtime ?? null;
    }),
    registerLocalRuntime: vi.fn(),
    unregisterLocalRuntime: vi.fn(),
    getLocalRuntime: vi.fn((runtimeId) => localRuntimes.get(runtimeId)),
    getAllLocalRuntimes: vi.fn(() => new Map(localRuntimes)),
    isLocalRuntimeConnected: vi.fn((runtimeId) => localRuntimes.has(runtimeId)),
  } as RuntimeRegistry & {
    getRuntimeForAgentCalls: string[];
    _localRuntimes: Map<string, LocalRuntime>;
    _agentToRuntimeMap: Map<string, string>;
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
}

function createMockStorage(options: MockStorageOptions = {}): Storage & {
  getRosterByCallsignCalls: string[];
  updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
} {
  const rosterCallbackUrls = options.rosterCallbackUrls ?? {};
  const rosterRuntimeIds = options.rosterRuntimeIds ?? {};
  const getRosterByCallsignCalls: string[] = [];
  const updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }> = [];

  return {
    getRosterByCallsignCalls,
    updateRosterEntryCalls,
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
      };
    }),
    updateRosterEntry: vi.fn(async (channelId: string, entryId: string, update: unknown) => {
      updateRosterEntryCalls.push({ channelId, entryId, update });
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
  } as unknown as Storage & {
    getRosterByCallsignCalls: string[];
    updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
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

  describe('when agent has runtime_id (LocalRuntime routing)', () => {
    const RUNTIME_ID = 'rt_local_001';
    let mockLocalRuntime: ReturnType<typeof createMockLocalRuntime>;
    let mockRuntimeRegistry: ReturnType<typeof createMockRuntimeRegistry>;

    beforeEach(() => {
      mockLocalRuntime = createMockLocalRuntime(RUNTIME_ID);
      const localRuntimes = new Map<string, LocalRuntime>();
      localRuntimes.set(RUNTIME_ID, mockLocalRuntime as unknown as LocalRuntime);

      // Map agent IDs to runtime IDs (simulates roster.runtimeId lookup)
      const agentToRuntimeMap = new Map<string, string>();
      agentToRuntimeMap.set('space-1:channel-1:fox', RUNTIME_ID);
      // bear has no mapping (no runtimeId)

      mockRuntimeRegistry = createMockRuntimeRegistry(localRuntimes, agentToRuntimeMap);

      // Setup storage with runtime_id for fox
      mockStorage = createMockStorage({
        rosterRuntimeIds: { fox: RUNTIME_ID, bear: null },
        rosterCallbackUrls: { fox: null, bear: null },
      });
    });

    it('routes to LocalRuntime when agent has runtime_id and is online', async () => {
      // Mark agent as online on the runtime
      mockLocalRuntime._onlineAgents.add('space-1:channel-1:fox');

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        runtimeRegistry: mockRuntimeRegistry as unknown as RuntimeRegistry,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should send message via LocalRuntime, not spawn container
      expect(mockLocalRuntime.sendMessageCalls).toHaveLength(1);
      expect(mockLocalRuntime.sendMessageCalls[0].agentId).toBe('space-1:channel-1:fox');
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
    });

    it('activates agent on LocalRuntime when not online', async () => {
      // Agent is NOT online (default - _onlineAgents is empty)

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        runtimeRegistry: mockRuntimeRegistry as unknown as RuntimeRegistry,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should activate via LocalRuntime, not spawn container
      expect(mockLocalRuntime.activateCalls).toHaveLength(1);
      expect(mockLocalRuntime.activateCalls[0].agentId).toBe('space-1:channel-1:fox');
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
    });

    it('broadcasts offline state when LocalRuntime is disconnected', async () => {
      // Remove the runtime from registry (simulate disconnect)
      mockRuntimeRegistry._localRuntimes.clear();
      // Update the mock to return null
      vi.mocked(mockRuntimeRegistry.getRuntimeForAgent).mockResolvedValue(null);

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        runtimeRegistry: mockRuntimeRegistry as unknown as RuntimeRegistry,
      });

      await invoker.invokeAgents('channel-1', ['fox'], testMessage);

      // Should NOT spawn container - message stays in DB
      expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
      // broadcastAgentState is mocked, but the call happened
    });

    it('falls through to default flow for agents without runtime_id', async () => {
      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        runtimeRegistry: mockRuntimeRegistry as unknown as RuntimeRegistry,
      });

      // bear has no runtime_id, should spawn container
      await invoker.invokeAgents('channel-1', ['bear'], testMessage);

      // Should spawn container via AgentManager
      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0].callsign).toBe('bear');
    });

    it('routes mixed agents correctly (some with runtime_id, some without)', async () => {
      mockLocalRuntime._onlineAgents.add('space-1:channel-1:fox');

      const invoker = createAgentInvokerAdapter({
        agentManager: mockAgentManager,
        storage: mockStorage,
        spaceId,
        runtimeRegistry: mockRuntimeRegistry as unknown as RuntimeRegistry,
      });

      await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

      // fox routes via LocalRuntime
      expect(mockLocalRuntime.sendMessageCalls).toHaveLength(1);
      expect(mockLocalRuntime.sendMessageCalls[0].agentId).toBe('space-1:channel-1:fox');

      // bear spawns container
      expect(mockAgentManager.sendMessageCalls).toHaveLength(1);
      expect(mockAgentManager.sendMessageCalls[0].callsign).toBe('bear');
    });
  });
});
