import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  createAgentInvokerAdapter,
  buildMcpConfigsFromContext,
  expandMcpConfig,
} from './invoker-adapter.js';
import type { AgentManager } from './agent-manager.js';
import type { Storage, AgentDefinitionSummary, McpArtifactData } from '@cast/storage';
import type { Message } from '../handlers/messages.js';
import type { ConnectionManager } from '../websocket/index.js';
import type { McpServerConfig } from '../runtimes/runtime-protocol-handlers.js';

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
  /** Map of callsign -> status (default: 'active') */
  rosterStatuses?: Record<string, 'active' | 'paused' | 'archived'>;
  /** Map of runtimeId -> runtime record */
  runtimes?: Record<string, { status: string; config?: { wsConnectionId?: string } } | null>;
  /** Channel name for context (default: 'test-channel') */
  channelName?: string;
}

function createMockStorage(options: MockStorageOptions = {}): Storage & {
  getRosterByCallsignCalls: string[];
  updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
  getRuntimeCalls: string[];
  getMessageDeliveryContextCalls: Array<{ spaceId: string; channelId: string; callsigns: string[] }>;
} {
  const rosterCallbackUrls = options.rosterCallbackUrls ?? {};
  const rosterRuntimeIds = options.rosterRuntimeIds ?? {};
  const rosterHeartbeats = options.rosterHeartbeats ?? {};
  const rosterStatuses = options.rosterStatuses ?? {};
  const runtimes = options.runtimes ?? {};
  const channelName = options.channelName ?? 'test-channel';
  const getRosterByCallsignCalls: string[] = [];
  const updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }> = [];
  const getRuntimeCalls: string[] = [];
  const getMessageDeliveryContextCalls: Array<{ spaceId: string; channelId: string; callsigns: string[] }> = [];

  // Helper to build a roster entry
  const buildRosterEntry = (channelId: string, callsign: string) => {
    const callbackUrl = rosterCallbackUrls[callsign];
    const runtimeId = rosterRuntimeIds[callsign];
    const status = rosterStatuses[callsign] ?? 'active';
    return {
      id: `roster-${callsign}`,
      channelId,
      callsign,
      agentType: 'engineer',
      status,
      createdAt: new Date().toISOString(),
      callbackUrl: callbackUrl ?? undefined,
      runtimeId: runtimeId ?? undefined,
      lastHeartbeat: rosterHeartbeats[callsign] ?? undefined,
    };
  };

  // Helper to build a runtime record
  const buildRuntimeRecord = (runtimeId: string) => {
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
  };

  return {
    getRosterByCallsignCalls,
    updateRosterEntryCalls,
    getRuntimeCalls,
    getMessageDeliveryContextCalls,
    // New batch context method
    getMessageDeliveryContext: vi.fn(async (spaceId: string, channelId: string, callsigns: string[]) => {
      getMessageDeliveryContextCalls.push({ spaceId, channelId, callsigns });

      // Build agents map from requested callsigns
      const agents = new Map();
      const allCallsigns = Object.keys(rosterCallbackUrls);
      for (const callsign of callsigns) {
        if (allCallsigns.includes(callsign) || rosterCallbackUrls[callsign] !== undefined) {
          const roster = buildRosterEntry(channelId, callsign);
          const runtimeId = rosterRuntimeIds[callsign];
          const runtime = runtimeId ? buildRuntimeRecord(runtimeId) : null;
          agents.set(callsign, { roster, runtime });
        }
      }

      // Build full roster from all known callsigns
      const fullRoster = allCallsigns.map(cs => buildRosterEntry(channelId, cs));

      // Build definitions map (mock: each agent type has a simple definition)
      const definitions = new Map();
      definitions.set('engineer', [{
        slug: 'engineer',
        channelId: 'root',
        title: 'Engineer',
        tldr: 'A software engineer agent',
        content: 'You are a software engineer.',
        props: null,
      }]);

      return {
        channel: {
          id: channelId,
          name: channelName,
          tagline: 'Test channel',
          mission: 'Testing',
        },
        spaceOwnerCallsign: 'alice',
        fullRoster,
        agents,
        definitions,
        environments: [],
        rootChannelId: 'root-channel',
      };
    }),
    // New batch MCP fetch method
    getMcpArtifactsBySlug: vi.fn(async () => new Map()),
    // Legacy methods (kept for backwards compat but no longer used by invoker)
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      getRosterByCallsignCalls.push(callsign);
      const callbackUrl = rosterCallbackUrls[callsign];
      const runtimeId = rosterRuntimeIds[callsign];
      if (callbackUrl === undefined && runtimeId === undefined) {
        return null;
      }
      return buildRosterEntry(channelId, callsign);
    }),
    updateRosterEntry: vi.fn(async (channelId: string, entryId: string, update: unknown) => {
      updateRosterEntryCalls.push({ channelId, entryId, update });
    }),
    getRuntime: vi.fn(async (runtimeId: string) => {
      getRuntimeCalls.push(runtimeId);
      return buildRuntimeRecord(runtimeId);
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
    getMessageDeliveryContextCalls: Array<{ spaceId: string; channelId: string; callsigns: string[] }>;
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

// =============================================================================
// expandMcpConfig Tests
// =============================================================================

describe('expandMcpConfig', () => {
  it('expands ${VAR} references in env values', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'stdio',
      command: 'node',
      env: {
        API_KEY: '${MY_API_KEY}',
        STATIC: 'unchanged',
      },
    };
    const sharedEnv = { MY_API_KEY: 'secret-123' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.env?.API_KEY).toBe('secret-123');
    expect(result.env?.STATIC).toBe('unchanged');
  });

  it('expands ${VAR} references in args', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['--token', '${TOKEN}', '--verbose'],
    };
    const sharedEnv = { TOKEN: 'abc123' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.args).toEqual(['--token', 'abc123', '--verbose']);
  });

  it('expands ${VAR} references in url', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'http',
      url: 'https://api.example.com?key=${API_KEY}',
    };
    const sharedEnv = { API_KEY: 'key-456' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.url).toBe('https://api.example.com?key=key-456');
  });

  it('expands ${VAR} references in headers', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'http',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer ${AUTH_TOKEN}',
        'X-Custom': 'static-value',
      },
    };
    const sharedEnv = { AUTH_TOKEN: 'token-789' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.headers?.Authorization).toBe('Bearer token-789');
    expect(result.headers?.['X-Custom']).toBe('static-value');
  });

  it('replaces missing vars with empty string', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'stdio',
      command: 'node',
      env: {
        MISSING: '${DOES_NOT_EXIST}',
      },
    };
    const sharedEnv = {};

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.env?.MISSING).toBe('');
  });

  it('uses MCP own env value if not a reference', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'stdio',
      command: 'node',
      env: {
        LOCAL_VAR: 'local-value',
        REF_VAR: '${SHARED_VAR}',
      },
    };
    const sharedEnv = { SHARED_VAR: 'shared-value', LOCAL_VAR: 'should-not-use' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.env?.LOCAL_VAR).toBe('local-value');
    expect(result.env?.REF_VAR).toBe('shared-value');
  });

  it('handles multiple ${VAR} in same string', () => {
    const config: McpServerConfig = {
      name: 'test-mcp',
      transport: 'http',
      url: 'https://${HOST}:${PORT}/api',
    };
    const sharedEnv = { HOST: 'localhost', PORT: '8080' };

    const result = expandMcpConfig(config, sharedEnv);

    expect(result.url).toBe('https://localhost:8080/api');
  });
});

// =============================================================================
// buildMcpConfigsFromContext Tests
// =============================================================================

describe('buildMcpConfigsFromContext', () => {
  const channelId = 'channel-123';
  const authToken = 'test-auth-token';
  const platformMcpUrl = 'https://api.cast.app';

  describe('platform MCPs', () => {
    it('adds miriad and miriad-files MCPs when platformMcpUrl and authToken provided', async () => {
      const result = await buildMcpConfigsFromContext(
        undefined, // no definition
        new Map(),
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      expect(result).toHaveLength(2);
      
      const miriad = result.find(c => c.name === 'miriad');
      expect(miriad).toBeDefined();
      expect(miriad?.transport).toBe('http');
      expect(miriad?.url).toBe(`${platformMcpUrl}/mcp/${channelId}`);
      expect(miriad?.headers?.Authorization).toBe(`Container ${authToken}`);

      const miriadFiles = result.find(c => c.name === 'miriad-files');
      expect(miriadFiles).toBeDefined();
      expect(miriadFiles?.transport).toBe('stdio');
      expect(miriadFiles?.env?.CAST_CONTAINER_TOKEN).toBe(authToken);
    });

    it('skips platform MCPs when platformMcpUrl is undefined', async () => {
      const result = await buildMcpConfigsFromContext(
        undefined,
        new Map(),
        {},
        channelId,
        authToken,
        undefined, // no platformMcpUrl
      );

      expect(result).toHaveLength(0);
    });

    it('skips platform MCPs when authToken is empty', async () => {
      const result = await buildMcpConfigsFromContext(
        undefined,
        new Map(),
        {},
        channelId,
        '', // empty authToken
        platformMcpUrl,
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('system MCPs from definition', () => {
    it('adds system MCPs referenced in agent definition', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'my-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['my-mcp', {
          slug: 'my-mcp',
          channelId,
          props: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        }],
      ]);

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      // 2 platform MCPs + 1 system MCP
      expect(result).toHaveLength(3);
      
      const myMcp = result.find(c => c.name === 'my-mcp');
      expect(myMcp).toBeDefined();
      expect(myMcp?.transport).toBe('stdio');
      expect(myMcp?.command).toBe('node');
      expect(myMcp?.args).toEqual(['server.js']);
    });

    it('skips MCP if not found in pre-fetched artifacts', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'missing-mcp' }],
        },
      };

      const result = await buildMcpConfigsFromContext(
        definition,
        new Map(), // empty - MCP not pre-fetched
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      // Only platform MCPs, missing-mcp skipped
      expect(result).toHaveLength(2);
      expect(result.find(c => c.name === 'missing-mcp')).toBeUndefined();
    });

    it('skips MCP if no transport in props', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'bad-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['bad-mcp', {
          slug: 'bad-mcp',
          channelId,
          props: {
            // no transport!
            command: 'node',
          },
        }],
      ]);

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      // Only platform MCPs
      expect(result).toHaveLength(2);
    });

    it('skips HTTP OAuth MCPs without token fetcher', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'oauth-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['oauth-mcp', {
          slug: 'oauth-mcp',
          channelId,
          props: {
            transport: 'http',
            url: 'https://oauth-service.com',
            oauth: { type: 'oauth' },
          },
        }],
      ]);

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      // Only platform MCPs, OAuth MCP skipped
      expect(result).toHaveLength(2);
      expect(result.find(c => c.name === 'oauth-mcp')).toBeUndefined();
    });

    it('injects OAuth token for HTTP MCPs when token fetcher provided', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'oauth-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['oauth-mcp', {
          slug: 'oauth-mcp',
          channelId,
          props: {
            transport: 'http',
            url: 'https://oauth-service.com',
            oauth: { type: 'oauth' },
          },
        }],
      ]);

      const mockGetValidOAuthToken = vi.fn().mockResolvedValue('valid-oauth-token');

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
        mockGetValidOAuthToken,
        'space-123',
      );

      // Platform MCPs + OAuth MCP with token
      expect(result).toHaveLength(3);
      const oauthMcp = result.find(c => c.name === 'oauth-mcp');
      expect(oauthMcp).toBeDefined();
      expect(oauthMcp?.headers?.Authorization).toBe('Bearer valid-oauth-token');
      expect(mockGetValidOAuthToken).toHaveBeenCalledWith('space-123', channelId, 'oauth-mcp');
    });

    it('skips HTTP OAuth MCP when token fetch returns null', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'oauth-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['oauth-mcp', {
          slug: 'oauth-mcp',
          channelId,
          props: {
            transport: 'http',
            url: 'https://oauth-service.com',
            oauth: { type: 'oauth' },
          },
        }],
      ]);

      const mockGetValidOAuthToken = vi.fn().mockResolvedValue(null);

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
        mockGetValidOAuthToken,
        'space-123',
      );

      // Only platform MCPs, OAuth MCP skipped (no valid token)
      expect(result).toHaveLength(2);
      expect(result.find(c => c.name === 'oauth-mcp')).toBeUndefined();
    });

    it('allows stdio MCPs even with oauth field (oauth only applies to HTTP)', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'stdio-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['stdio-mcp', {
          slug: 'stdio-mcp',
          channelId,
          props: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            oauth: { type: 'oauth' }, // Should be ignored for stdio
          },
        }],
      ]);

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      // Platform MCPs + stdio MCP (oauth ignored)
      expect(result).toHaveLength(3);
      const stdioMcp = result.find(c => c.name === 'stdio-mcp');
      expect(stdioMcp).toBeDefined();
      expect(stdioMcp?.transport).toBe('stdio');
    });
  });

  describe('${VAR} expansion', () => {
    it('expands env vars in system MCP configs', async () => {
      const definition: AgentDefinitionSummary = {
        slug: 'test-agent',
        channelId,
        content: '',
        props: {
          mcp: [{ slug: 'env-mcp' }],
        },
      };

      const mcpArtifacts = new Map<string, McpArtifactData>([
        ['env-mcp', {
          slug: 'env-mcp',
          channelId,
          props: {
            transport: 'stdio',
            command: 'node',
            env: {
              API_KEY: '${SHARED_API_KEY}',
            },
          },
        }],
      ]);

      const sharedEnv = { SHARED_API_KEY: 'secret-key-123' };

      const result = await buildMcpConfigsFromContext(
        definition,
        mcpArtifacts,
        sharedEnv,
        channelId,
        authToken,
        platformMcpUrl,
      );

      const envMcp = result.find(c => c.name === 'env-mcp');
      expect(envMcp?.env?.API_KEY).toBe('secret-key-123');
    });

    it('does NOT expand vars in platform MCPs (miriad, miriad-files)', async () => {
      const sharedEnv = { 
        CAST_API_URL: 'should-not-override',
        CAST_CONTAINER_TOKEN: 'should-not-override',
      };

      const result = await buildMcpConfigsFromContext(
        undefined,
        new Map(),
        sharedEnv,
        channelId,
        authToken,
        platformMcpUrl,
      );

      const miriadFiles = result.find(c => c.name === 'miriad-files');
      // Platform MCP env should use the actual values, not expanded from sharedEnv
      expect(miriadFiles?.env?.CAST_API_URL).toBe(platformMcpUrl);
      expect(miriadFiles?.env?.CAST_CONTAINER_TOKEN).toBe(authToken);
    });
  });

  describe('no definition', () => {
    it('returns only platform MCPs when definition is undefined', async () => {
      const result = await buildMcpConfigsFromContext(
        undefined,
        new Map(),
        {},
        channelId,
        authToken,
        platformMcpUrl,
      );

      expect(result).toHaveLength(2);
      expect(result.map(c => c.name)).toEqual(['miriad', 'miriad-files']);
    });
  });
});

// =============================================================================
// buildPromptFromContext Tests
// =============================================================================

import { buildPromptFromContext, resolveEnvironmentFromContext } from './invoker-adapter.js';
import type { MessageDeliveryContext } from '@cast/storage';

describe('buildPromptFromContext', () => {
  // Helper to create a minimal context
  function createContext(overrides: Partial<MessageDeliveryContext> = {}): MessageDeliveryContext {
    return {
      channel: { id: 'ch-1', name: 'test-channel', tagline: 'Test', mission: 'Testing' },
      spaceOwnerCallsign: 'alice',
      fullRoster: [],
      agents: new Map(),
      definitions: new Map(),
      environments: [],
      rootChannelId: 'root-channel',
      ...overrides,
    };
  }

  it('prefers channel definition over root definition', () => {
    const context = createContext({
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map([
        ['builder', [
          { slug: 'builder', channelId: 'root-channel', title: 'Root Builder', tldr: null, content: 'Root builder content', props: null },
          { slug: 'builder', channelId: 'ch-1', title: 'Channel Builder', tldr: null, content: 'Channel builder content', props: null },
        ]],
      ]),
      fullRoster: [{ id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }],
    });

    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');

    // The prompt should include channel-specific definition content
    expect(prompt).toContain('Channel builder content');
    expect(prompt).not.toContain('Root builder content');
  });

  it('falls back to root definition when no channel definition exists', () => {
    const context = createContext({
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map([
        ['builder', [
          { slug: 'builder', channelId: 'root-channel', title: 'Root Builder', tldr: null, content: 'Root builder content', props: null },
        ]],
      ]),
      fullRoster: [{ id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }],
    });

    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');

    // Should use root definition when channel definition doesn't exist
    expect(prompt).toContain('Root builder content');
  });

  it('handles missing definition gracefully', () => {
    const context = createContext({
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'unknown-type', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map(), // No definitions at all
      fullRoster: [{ id: 'r1', callsign: 'fox', agentType: 'unknown-type', status: 'active' }],
    });

    // Should not throw, returns a prompt without definition content
    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');
    expect(typeof prompt).toBe('string');
  });

  it('includes channel context in prompt', () => {
    const context = createContext({
      channel: { id: 'ch-1', name: 'my-channel', tagline: 'My tagline', mission: 'My mission' },
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map([
        ['builder', [{ slug: 'builder', channelId: 'ch-1', title: 'Builder', tldr: null, content: 'Build stuff', props: null }]],
      ]),
      fullRoster: [{ id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }],
    });

    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');

    expect(prompt).toContain('my-channel');
  });

  it('includes roster in prompt', () => {
    const context = createContext({
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map([
        ['builder', [{ slug: 'builder', channelId: 'ch-1', title: 'Builder', tldr: null, content: 'Build', props: null }]],
      ]),
      fullRoster: [
        { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' },
        { id: 'r2', callsign: 'bear', agentType: 'reviewer', status: 'active' },
      ],
    });

    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');

    // Roster should be included
    expect(prompt).toContain('fox');
    expect(prompt).toContain('bear');
  });

  it('includes space owner callsign', () => {
    const context = createContext({
      spaceOwnerCallsign: 'svale',
      agents: new Map([
        ['fox', { roster: { id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }, runtime: null }],
      ]),
      definitions: new Map([
        ['builder', [{ slug: 'builder', channelId: 'ch-1', title: 'Builder', tldr: null, content: 'Build', props: null }]],
      ]),
      fullRoster: [{ id: 'r1', callsign: 'fox', agentType: 'builder', status: 'active' }],
    });

    const prompt = buildPromptFromContext(context, 'ch-1', 'fox');

    expect(prompt).toContain('svale');
  });
});

// =============================================================================
// resolveEnvironmentFromContext Tests
// =============================================================================

describe('resolveEnvironmentFromContext', () => {
  // Helper to create minimal context
  function createContext(overrides: Partial<MessageDeliveryContext> = {}): MessageDeliveryContext {
    return {
      channel: { id: 'ch-1', name: 'test-channel', tagline: 'Test', mission: 'Testing' },
      spaceOwnerCallsign: 'alice',
      fullRoster: [],
      agents: new Map(),
      definitions: new Map(),
      environments: [],
      rootChannelId: 'root-channel',
      ...overrides,
    };
  }

  // Mock storage with configurable secret values
  function createMockStorageForEnv(secretValues: Record<string, string> = {}): Storage {
    return {
      getSecretValue: vi.fn(async (_spaceId: string, _channelId: string, _slug: string, key: string) => {
        return secretValues[key] ?? null;
      }),
    } as unknown as Storage;
  }

  it('returns empty object when no environments', async () => {
    const context = createContext({ environments: [] });
    const storage = createMockStorageForEnv();

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    expect(result).toEqual({});
  });

  it('loads root environment variables as base layer', async () => {
    const context = createContext({
      rootChannelId: 'root-channel',
      environments: [
        {
          slug: 'system.environment',
          channelId: 'root-channel',
          props: { variables: { API_URL: 'https://api.example.com', DEBUG: 'false' } },
          secrets: null,
        },
      ],
    });
    const storage = createMockStorageForEnv();

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    expect(result).toEqual({
      API_URL: 'https://api.example.com',
      DEBUG: 'false',
    });
  });

  it('channel environment overlays root (wins on conflict)', async () => {
    const context = createContext({
      rootChannelId: 'root-channel',
      environments: [
        {
          slug: 'system.environment',
          channelId: 'root-channel',
          props: { variables: { API_URL: 'https://root.example.com', ROOT_ONLY: 'yes' } },
          secrets: null,
        },
        {
          slug: 'system.environment',
          channelId: 'ch-1',
          props: { variables: { API_URL: 'https://channel.example.com', CHANNEL_ONLY: 'yes' } },
          secrets: null,
        },
      ],
    });
    const storage = createMockStorageForEnv();

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    expect(result).toEqual({
      API_URL: 'https://channel.example.com', // Channel wins
      ROOT_ONLY: 'yes', // From root
      CHANNEL_ONLY: 'yes', // From channel
    });
  });

  it('decrypts secrets from root and channel', async () => {
    const context = createContext({
      rootChannelId: 'root-channel',
      environments: [
        {
          slug: 'system.environment',
          channelId: 'root-channel',
          props: { variables: {} },
          secrets: { ROOT_SECRET: { encrypted: '...', iv: '...' } },
        },
        {
          slug: 'system.environment',
          channelId: 'ch-1',
          props: { variables: {} },
          secrets: { CHANNEL_SECRET: { encrypted: '...', iv: '...' } },
        },
      ],
    });
    const storage = createMockStorageForEnv({
      ROOT_SECRET: 'root-secret-value',
      CHANNEL_SECRET: 'channel-secret-value',
    });

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    expect(result).toEqual({
      ROOT_SECRET: 'root-secret-value',
      CHANNEL_SECRET: 'channel-secret-value',
    });
  });

  it('channel secret overwrites root secret with same key', async () => {
    const context = createContext({
      rootChannelId: 'root-channel',
      environments: [
        {
          slug: 'system.environment',
          channelId: 'root-channel',
          props: { variables: {} },
          secrets: { SHARED_SECRET: { encrypted: '...root...', iv: '...' } },
        },
        {
          slug: 'system.environment',
          channelId: 'ch-1',
          props: { variables: {} },
          secrets: { SHARED_SECRET: { encrypted: '...channel...', iv: '...' } },
        },
      ],
    });
    // Storage returns different values based on which channelId is passed
    const storage = {
      getSecretValue: vi.fn(async (_spaceId: string, channelId: string, _slug: string, _key: string) => {
        return channelId === 'root-channel' ? 'root-secret' : 'channel-secret';
      }),
    } as unknown as Storage;

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    // Channel secret should win
    expect(result.SHARED_SECRET).toBe('channel-secret');
  });

  it('merges multiple environment artifacts alphabetically by slug', async () => {
    const context = createContext({
      rootChannelId: 'root-channel',
      environments: [
        {
          slug: 'z-env', // Processed second (alphabetically)
          channelId: 'ch-1',
          props: { variables: { SHARED: 'from-z', Z_ONLY: 'z' } },
          secrets: null,
        },
        {
          slug: 'a-env', // Processed first (alphabetically)
          channelId: 'ch-1',
          props: { variables: { SHARED: 'from-a', A_ONLY: 'a' } },
          secrets: null,
        },
      ],
    });
    const storage = createMockStorageForEnv();

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    // 'z-env' is processed after 'a-env', so its SHARED value wins
    expect(result).toEqual({
      SHARED: 'from-z',
      A_ONLY: 'a',
      Z_ONLY: 'z',
    });
  });

  it('process.env takes precedence over artifact values (security)', async () => {
    // Set a process.env value for this test
    const originalValue = process.env.TEST_SECURITY_VAR;
    process.env.TEST_SECURITY_VAR = 'from-process-env';

    try {
      const context = createContext({
        environments: [
          {
            slug: 'system.environment',
            channelId: 'ch-1',
            props: { variables: { TEST_SECURITY_VAR: 'from-artifact' } },
            secrets: null,
          },
        ],
      });
      const storage = createMockStorageForEnv();

      const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

      // process.env should win
      expect(result.TEST_SECURITY_VAR).toBe('from-process-env');
    } finally {
      // Restore original value
      if (originalValue === undefined) {
        delete process.env.TEST_SECURITY_VAR;
      } else {
        process.env.TEST_SECURITY_VAR = originalValue;
      }
    }
  });

  it('handles null props gracefully', async () => {
    const context = createContext({
      environments: [
        {
          slug: 'system.environment',
          channelId: 'ch-1',
          props: null,
          secrets: null,
        },
      ],
    });
    const storage = createMockStorageForEnv();

    const result = await resolveEnvironmentFromContext(context, storage, 'space-1', 'ch-1');

    expect(result).toEqual({});
  });
});
