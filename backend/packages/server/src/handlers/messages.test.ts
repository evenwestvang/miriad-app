import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createMessageRoutes,
  filterMessagesForAgent,
  getAddressedAgents,
  type Message,
  type MessageStorage,
  type RosterProvider,
  type AgentInvoker,
} from './messages.js';
import type { ConnectionManager } from '../websocket/index.js';
import type { ChannelRoster } from '@cast/core';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockConnectionManager(): ConnectionManager & {
  broadcastCalls: Array<{ channelId: string; frame: string }>;
} {
  const broadcastCalls: Array<{ channelId: string; frame: string }> = [];

  return {
    broadcastCalls,
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getChannelConnections: vi.fn(() => []),
    getConnection: vi.fn(),
    broadcast: vi.fn(async (channelId: string, frame: string) => {
      broadcastCalls.push({ channelId, frame });
    }),
    send: vi.fn(),
    getConnectionCount: vi.fn(() => 0),
    getChannelConnectionCount: vi.fn(() => 0),
    closeAll: vi.fn(),
  };
}

function createMockMessageStorage(): MessageStorage & {
  messages: Map<string, Message[]>;
} {
  const messages = new Map<string, Message[]>();

  return {
    messages,
    saveMessage: vi.fn(async (channelId: string, message: Message) => {
      const existing = messages.get(channelId) || [];
      messages.set(channelId, [...existing, message]);
    }),
    getMessages: vi.fn(async (channelId: string, options?: { limit?: number }) => {
      const channelMessages = messages.get(channelId) || [];
      const limit = options?.limit || 50;
      return channelMessages.slice(-limit);
    }),
    deleteMessage: vi.fn(async (channelId: string, messageId: string) => {
      const existing = messages.get(channelId) || [];
      messages.set(
        channelId,
        existing.filter((m) => m.id !== messageId)
      );
    }),
  };
}

function createMockRosterProvider(roster: ChannelRoster | null): RosterProvider {
  return {
    getRoster: vi.fn(async () => roster),
    getLeader: vi.fn(async () => roster?.leader || null),
  };
}

// =============================================================================
// Unit Tests
// =============================================================================

describe('filterMessagesForAgent', () => {
  const messages: Message[] = [
    {
      id: 'msg1',
      channelId: 'ch1',
      sender: 'human',
      senderType: 'user',
      type: 'message',
      content: '@fox help',
      timestamp: '2026-01-01T00:00:00Z',
      isComplete: true,
      addressedAgents: ['fox'],
    },
    {
      id: 'msg2',
      channelId: 'ch1',
      sender: 'fox',
      senderType: 'agent',
      type: 'message',
      content: 'I can help',
      timestamp: '2026-01-01T00:01:00Z',
      isComplete: true,
    },
    {
      id: 'msg3',
      channelId: 'ch1',
      sender: 'human',
      senderType: 'user',
      type: 'message',
      content: '@bear check this',
      timestamp: '2026-01-01T00:02:00Z',
      isComplete: true,
      addressedAgents: ['bear'],
    },
    {
      id: 'msg4',
      channelId: 'ch1',
      sender: 'bear',
      senderType: 'agent',
      type: 'message',
      content: 'Looking at it',
      timestamp: '2026-01-01T00:03:00Z',
      isComplete: true,
    },
  ];

  it('returns messages addressed to the agent', () => {
    const filtered = filterMessagesForAgent(messages, 'fox');
    expect(filtered.map((m) => m.id)).toContain('msg1');
  });

  it('returns messages sent by the agent', () => {
    const filtered = filterMessagesForAgent(messages, 'fox');
    expect(filtered.map((m) => m.id)).toContain('msg2');
  });

  it('excludes messages addressed to other agents', () => {
    const filtered = filterMessagesForAgent(messages, 'fox');
    expect(filtered.map((m) => m.id)).not.toContain('msg3');
    expect(filtered.map((m) => m.id)).not.toContain('msg4');
  });

  it('bear sees only their messages', () => {
    const filtered = filterMessagesForAgent(messages, 'bear');
    expect(filtered.map((m) => m.id)).toEqual(['msg3', 'msg4']);
  });
});

describe('getAddressedAgents', () => {
  const roster: ChannelRoster = {
    agents: ['fox', 'bear', 'owl'],
    leader: 'fox',
  };

  it('extracts @mentions from content', () => {
    const result = getAddressedAgents('@bear help', true, roster);
    expect(result.addressedAgents).toEqual(['bear']);
    expect(result.isBroadcast).toBe(false);
  });

  it('handles @channel as broadcast', () => {
    const result = getAddressedAgents('@channel update', true, roster);
    expect(result.addressedAgents).toEqual(['fox', 'bear', 'owl']);
    expect(result.isBroadcast).toBe(true);
  });

  it('routes unaddressed human messages to leader', () => {
    const result = getAddressedAgents('hello', true, roster);
    expect(result.addressedAgents).toEqual(['fox']);
    expect(result.isBroadcast).toBe(false);
  });

  it('does not route unaddressed agent messages', () => {
    const result = getAddressedAgents('task done', false, roster);
    expect(result.addressedAgents).toEqual([]);
    expect(result.isBroadcast).toBe(false);
  });
});

// =============================================================================
// Route Tests
// =============================================================================

describe('Message Routes', () => {
  let app: Hono;
  let mockConnectionManager: ReturnType<typeof createMockConnectionManager>;
  let mockMessageStorage: ReturnType<typeof createMockMessageStorage>;
  let mockRosterProvider: RosterProvider;
  let mockAgentInvoker: AgentInvoker;

  const roster: ChannelRoster = {
    agents: ['fox', 'bear'],
    leader: 'fox',
  };

  beforeEach(() => {
    mockConnectionManager = createMockConnectionManager();
    mockMessageStorage = createMockMessageStorage();
    mockRosterProvider = createMockRosterProvider(roster);
    mockAgentInvoker = {
      invokeAgents: vi.fn(),
    };

    const messageRoutes = createMessageRoutes({
      connectionManager: mockConnectionManager,
      messageStorage: mockMessageStorage,
      rosterProvider: mockRosterProvider,
      agentInvoker: mockAgentInvoker,
    });

    app = new Hono();
    app.route('/channels', messageRoutes);
  });

  describe('POST /channels/:id/messages', () => {
    it('creates and broadcasts a message', async () => {
      const res = await app.request('/channels/channel-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox help me',
          sender: 'human-user',
          senderType: 'user',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.message).toBeDefined();
      expect(json.message.content).toBe('@fox help me');
      expect(json.message.addressedAgents).toEqual(['fox']);

      // Check broadcast
      expect(mockConnectionManager.broadcastCalls).toHaveLength(1);
      const frame = JSON.parse(mockConnectionManager.broadcastCalls[0].frame);
      expect(frame.v.content).toBe('@fox help me');
      expect(frame.v.mentions).toEqual(['fox']);
    });

    it('invokes agents on @mention', async () => {
      await app.request('/channels/channel-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@bear check this',
          sender: 'human-user',
        }),
      });

      expect(mockAgentInvoker.invokeAgents).toHaveBeenCalledWith(
        'channel-1',
        ['bear'],
        expect.objectContaining({ content: '@bear check this' })
      );
    });

    it('routes to leader when no @mention', async () => {
      await app.request('/channels/channel-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'hello',
          sender: 'human-user',
        }),
      });

      expect(mockAgentInvoker.invokeAgents).toHaveBeenCalledWith(
        'channel-1',
        ['fox'], // leader
        expect.anything()
      );
    });

    it('broadcasts to all on @channel', async () => {
      const res = await app.request('/channels/channel-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@channel status update',
          sender: 'human-user',
        }),
      });

      const json = await res.json();
      expect(json.message.addressedAgents).toEqual(['fox', 'bear']);

      expect(mockAgentInvoker.invokeAgents).toHaveBeenCalledWith(
        'channel-1',
        ['fox', 'bear'],
        expect.anything()
      );
    });

    it('rejects missing content', async () => {
      const res = await app.request('/channels/channel-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: 'test' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Message content required');
    });

    it('returns 404 for missing roster', async () => {
      mockRosterProvider = createMockRosterProvider(null);
      const routes = createMessageRoutes({
        connectionManager: mockConnectionManager,
        messageStorage: mockMessageStorage,
        rosterProvider: mockRosterProvider,
      });

      const testApp = new Hono();
      testApp.route('/channels', routes);

      const res = await testApp.request('/channels/unknown/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /channels/:id/messages', () => {
    beforeEach(async () => {
      // Seed some messages
      await mockMessageStorage.saveMessage('channel-1', {
        id: 'msg1',
        channelId: 'channel-1',
        sender: 'human',
        senderType: 'user',
        type: 'message',
        content: '@fox help',
        timestamp: '2026-01-01T00:00:00Z',
        isComplete: true,
        addressedAgents: ['fox'],
      });
      await mockMessageStorage.saveMessage('channel-1', {
        id: 'msg2',
        channelId: 'channel-1',
        sender: 'fox',
        senderType: 'agent',
        type: 'message',
        content: 'Here to help',
        timestamp: '2026-01-01T00:01:00Z',
        isComplete: true,
      });
    });

    it('returns all messages', async () => {
      const res = await app.request('/channels/channel-1/messages');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toHaveLength(2);
    });

    it('filters messages for agent', async () => {
      const res = await app.request('/channels/channel-1/messages?forAgent=fox');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toHaveLength(2); // fox sees both
    });

    it('excludes messages not addressed to agent', async () => {
      // Add message for bear only
      await mockMessageStorage.saveMessage('channel-1', {
        id: 'msg3',
        channelId: 'channel-1',
        sender: 'human',
        senderType: 'user',
        type: 'message',
        content: '@bear check',
        timestamp: '2026-01-01T00:02:00Z',
        isComplete: true,
        addressedAgents: ['bear'],
      });

      const res = await app.request('/channels/channel-1/messages?forAgent=fox');
      const json = await res.json();

      // fox should not see msg3
      const ids = json.messages.map((m: Message) => m.id);
      expect(ids).not.toContain('msg3');
    });
  });
});
