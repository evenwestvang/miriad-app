import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentInvokerAdapter } from './invoker-adapter.js';
import type { AgentManager } from './agent-manager.js';
import type { Storage } from '@cast/storage';
import type { Message } from '../handlers/messages.js';

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
// Mock Storage
// =============================================================================

interface MockStorageOptions {
  /** Map of callsign -> callbackUrl (null means no container running) */
  rosterCallbackUrls?: Record<string, string | null>;
}

function createMockStorage(options: MockStorageOptions = {}): Storage & {
  getRosterByCallsignCalls: string[];
  updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }>;
} {
  const rosterCallbackUrls = options.rosterCallbackUrls ?? {};
  const getRosterByCallsignCalls: string[] = [];
  const updateRosterEntryCalls: Array<{ channelId: string; entryId: string; update: unknown }> = [];

  return {
    getRosterByCallsignCalls,
    updateRosterEntryCalls,
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      getRosterByCallsignCalls.push(callsign);
      const callbackUrl = rosterCallbackUrls[callsign];
      if (callbackUrl === undefined) {
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
});
