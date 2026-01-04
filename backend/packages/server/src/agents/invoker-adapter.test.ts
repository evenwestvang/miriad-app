import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentInvokerAdapter } from './invoker-adapter.js';
import type { AgentManager } from './agent-manager.js';
import type { Message } from '../handlers/messages.js';

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
    // Other methods not used by adapter
    getOrSpawn: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
    getChannelAgents: vi.fn(),
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
// Tests
// =============================================================================

describe('createAgentInvokerAdapter', () => {
  let mockAgentManager: ReturnType<typeof createMockAgentManager>;
  const spaceId = 'space-1';

  const testMessage: Message = {
    id: 'msg-1',
    channelId: 'channel-1',
    sender: 'alice',
    senderType: 'human',
    type: 'message',
    content: '@fox @bear help me please',
    timestamp: new Date().toISOString(),
    isComplete: true,
    addressedAgents: ['fox', 'bear'],
  };

  beforeEach(() => {
    mockAgentManager = createMockAgentManager();
  });

  it('invokes AgentManager.sendMessage for each target', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
      spaceId,
    });

    await invoker.invokeAgents('channel-1', ['fox', 'bear'], testMessage);

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

  it('does nothing when targets is empty', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
      spaceId,
    });

    await invoker.invokeAgents('channel-1', [], testMessage);

    expect(mockAgentManager.sendMessageCalls).toHaveLength(0);
  });

  it('invokes single target correctly', async () => {
    const invoker = createAgentInvokerAdapter({
      agentManager: mockAgentManager,
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
      spaceId: 'different-space',
    });

    await invoker.invokeAgents('channel-1', ['fox', 'bear', 'owl'], testMessage);

    for (const call of mockAgentManager.sendMessageCalls) {
      expect(call.spaceId).toBe('different-space');
    }
  });
});
