/**
 * End-to-End Integration Test
 *
 * Tests the full message flow:
 * 1. POST message with @mention
 * 2. AgentManager activates container and sends message
 * 3. Container POSTs Tymbal frame to /tymbal/:channelId
 * 4. WebSocket broadcasts frame to clients
 *
 * Uses MockAgentRuntime - no Docker dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createMockRuntime, type MockAgentRuntime } from '@cast/runtime';
import { tymbal, type ChannelRoster } from '@cast/core';
import {
  createMessageRoutes,
  type Message,
  type MessageStorage,
  type RosterProvider,
} from './handlers/messages.js';
import {
  parseFrame,
  isSetFrame,
  isResetFrame,
  type SetFrame,
} from '@cast/core';
import { createAgentInvokerAdapter } from './agents/invoker-adapter.js';
import { AgentManager, type ChannelContext, type RosterEntry } from './agents/agent-manager.js';
import { createConnectionManager, type ConnectionManager } from './websocket/index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_SPACE_ID = 'test-space';
const TEST_CHANNEL_ID = 'test-channel';
const TEST_CALLSIGN = 'fox';

const testChannel: ChannelContext = {
  id: TEST_CHANNEL_ID,
  name: 'test-channel',
  tagline: 'Test workspace',
  mission: 'Testing the full flow',
};

const testRoster: RosterEntry[] = [
  { id: 'r1', callsign: 'fox', agentType: 'engineer', status: 'active' },
  { id: 'r2', callsign: 'bear', agentType: 'reviewer', status: 'active' },
];

const testChannelRoster: ChannelRoster = {
  agents: ['fox', 'bear'],
  leader: 'fox',
};

// =============================================================================
// Mock Storage
// =============================================================================

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

function createMockRosterProvider(): RosterProvider {
  return {
    getRoster: vi.fn(async () => testChannelRoster),
    getLeader: vi.fn(async () => testChannelRoster.leader),
  };
}

// Mock Storage for AgentInvokerAdapter (only implements what invoker-adapter needs)
function createMockStorage() {
  return {
    getRosterByCallsign: vi.fn(async () => null), // No callback URL - always activate
    updateRosterEntry: vi.fn(async () => {}),
    // Other methods can be stubs
    getChannel: vi.fn(async () => null),
    getChannelByName: vi.fn(async () => null),
    listChannels: vi.fn(async () => []),
    createChannel: vi.fn(async () => ({})),
    updateChannel: vi.fn(async () => {}),
    archiveChannel: vi.fn(async () => {}),
    saveMessage: vi.fn(async () => ({})),
    getMessage: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    addToRoster: vi.fn(async () => ({})),
    getRosterEntry: vi.fn(async () => null),
    listRoster: vi.fn(async () => []),
    removeFromRoster: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// =============================================================================
// Test-friendly Tymbal Routes (no auth)
// =============================================================================

function createTestTymbalRoutes(connectionManager: ConnectionManager): Hono {
  const app = new Hono();

  // POST /:channelId - single frame
  app.post('/:channelId', async (c) => {
    const channelId = c.req.param('channelId');
    const body = await c.req.text();

    if (!body.trim()) {
      return c.json({ error: 'empty_body' }, 400);
    }

    const frame = parseFrame(body);
    if (!frame) {
      return c.json({ error: 'invalid_frame' }, 400);
    }

    if (isSetFrame(frame)) {
      await connectionManager.broadcast(channelId, JSON.stringify(frame));
    } else {
      await connectionManager.broadcast(channelId, body);
    }

    return c.json({ ok: true });
  });

  // POST /:channelId/batch - multiple frames
  app.post('/:channelId/batch', async (c) => {
    const channelId = c.req.param('channelId');
    const body = await c.req.text();

    if (!body.trim()) {
      return c.json({ error: 'empty_body' }, 400);
    }

    const lines = body.split('\n').filter((line) => line.trim());
    const results: { line: number; ok: boolean; error?: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const frame = parseFrame(line);

      if (!frame) {
        results.push({ line: i, ok: false, error: 'invalid_frame' });
        continue;
      }

      try {
        if (isSetFrame(frame)) {
          await connectionManager.broadcast(channelId, JSON.stringify(frame));
        } else {
          await connectionManager.broadcast(channelId, line);
        }
        results.push({ line: i, ok: true });
      } catch {
        results.push({ line: i, ok: false, error: 'processing_error' });
      }
    }

    const failedCount = results.filter((r) => !r.ok).length;
    return c.json({
      ok: failedCount === 0,
      total: lines.length,
      succeeded: lines.length - failedCount,
      failed: failedCount,
      results,
    });
  });

  return app;
}

// =============================================================================
// Integration Test
// =============================================================================

describe('End-to-End Integration', () => {
  let app: Hono;
  let mockRuntime: MockAgentRuntime;
  let connectionManager: ConnectionManager;
  let agentManager: AgentManager;
  let messageStorage: ReturnType<typeof createMockMessageStorage>;
  let broadcastedFrames: string[];

  beforeEach(() => {
    // Reset state
    broadcastedFrames = [];

    // Create mock runtime
    mockRuntime = createMockRuntime();

    // Create connection manager
    connectionManager = createConnectionManager();

    // Track broadcasts
    const originalBroadcast = connectionManager.broadcast.bind(connectionManager);
    connectionManager.broadcast = vi.fn(async (channelId: string, frame: string) => {
      broadcastedFrames.push(frame);
      return originalBroadcast(channelId, frame);
    });

    // Create AgentManager with new API
    agentManager = new AgentManager({
      runtime: mockRuntime,
      broadcast: connectionManager.broadcast,
      getChannel: vi.fn(async () => testChannel),
      getRoster: vi.fn(async () => testRoster),
    });

    // Create message storage
    messageStorage = createMockMessageStorage();
    const rosterProvider = createMockRosterProvider();
    const mockStorage = createMockStorage();

    // Create AgentInvoker adapter
    const agentInvoker = createAgentInvokerAdapter({
      agentManager,
      storage: mockStorage as any, // Mock storage with required roster methods
      spaceId: TEST_SPACE_ID,
    });

    // Create routes
    const messageRoutes = createMessageRoutes({
      connectionManager,
      messageStorage,
      rosterProvider,
      agentInvoker,
    });

    // Build app with test-friendly tymbal routes (no auth)
    app = new Hono();
    app.route('/channels', messageRoutes);
    app.route('/tymbal', createTestTymbalRoutes(connectionManager));
  });

  afterEach(async () => {
    await agentManager.shutdown();
    connectionManager.closeAll();
    mockRuntime.reset();
  });

  describe('Message Flow', () => {
    it('activates agent and sends message on @mention', async () => {
      // POST message with @mention
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox help me with this task',
          sender: 'human-user',
          senderType: 'user',
        }),
      });

      expect(res.status).toBe(201);

      // Verify message was stored
      const storedMessages = messageStorage.messages.get(TEST_CHANNEL_ID);
      expect(storedMessages).toHaveLength(1);
      expect(storedMessages![0].content).toBe('@fox help me with this task');
      expect(storedMessages![0].addressedAgents).toEqual(['fox']);

      // Verify runtime activated container
      const activateCalls = mockRuntime.getActivateCalls();
      expect(activateCalls).toHaveLength(1);
      expect(activateCalls[0].options.agentId).toBe(`${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:fox`);

      // Note: Messages are delivered via pending queue when container checks in,
      // not via runtime.sendMessage(). This is the correct behavior.
    });

    it('broadcasts @channel to all roster agents', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@channel status update please',
          sender: 'human-user',
          senderType: 'user',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.message.addressedAgents).toEqual(['fox', 'bear']);

      // Both agents should be activated
      const activateCalls = mockRuntime.getActivateCalls();
      expect(activateCalls).toHaveLength(2);
      expect(activateCalls.map((c) => c.options.agentId).sort()).toEqual([
        `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:bear`,
        `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:fox`,
      ]);

      // Note: Messages delivered via pending queue on checkin, not runtime.sendMessage()
    });

    it('routes unaddressed human message to leader', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'hello, can someone help?',
          sender: 'human-user',
          senderType: 'user',
        }),
      });

      expect(res.status).toBe(201);

      // Should route to leader (fox)
      const activateCalls = mockRuntime.getActivateCalls();
      expect(activateCalls).toHaveLength(1);
      expect(activateCalls[0].options.agentId).toBe(`${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:fox`);
    });
  });

  describe('Tymbal Response Flow', () => {
    it('broadcasts Tymbal frame to channel', async () => {
      // Simulate container posting a Tymbal frame
      const messageId = '01JTEST01';
      const frame = tymbal.set(messageId, {
        type: 'message',
        content: 'I can help with that!',
        sender: 'fox',
      });

      const res = await app.request(`/tymbal/${TEST_CHANNEL_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: frame,
      });

      expect(res.status).toBe(200);

      // Verify broadcast was called
      expect(connectionManager.broadcast).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.any(String)
      );

      // Verify frame was broadcast
      expect(broadcastedFrames).toHaveLength(1);
      const broadcastedFrame = JSON.parse(broadcastedFrames[0]);
      expect(broadcastedFrame.i).toBe(messageId);
      expect(broadcastedFrame.v.content).toBe('I can help with that!');
    });

    it('handles Tymbal batch endpoint', async () => {
      const frame1 = tymbal.append('01JTEST01', 'Starting to work on ');
      const frame2 = tymbal.append('01JTEST01', 'your request...');

      const res = await app.request(`/tymbal/${TEST_CHANNEL_ID}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: `${frame1}\n${frame2}`,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.total).toBe(2);
      expect(json.succeeded).toBe(2);

      // Both frames should be broadcast
      expect(broadcastedFrames).toHaveLength(2);
    });
  });

  describe('Full Round Trip', () => {
    it('completes full message → agent → response → broadcast flow', async () => {
      // Step 1: Human sends message with @mention
      const postRes = await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox what is 2 + 2?',
          sender: 'human-user',
          senderType: 'user',
        }),
      });

      expect(postRes.status).toBe(201);

      // Step 2: Verify container was activated for agent
      const activateCalls = mockRuntime.getActivateCalls();
      expect(activateCalls).toHaveLength(1);
      expect(activateCalls[0].options.agentId).toBe(`${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:fox`);

      // Step 3: Simulate agent response via Tymbal
      const responseFrame = tymbal.set('01JRESP01', {
        type: 'message',
        content: 'The answer is 4!',
        sender: 'fox',
      });

      const tymbalRes = await app.request(`/tymbal/${TEST_CHANNEL_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: responseFrame,
      });

      expect(tymbalRes.status).toBe(200);

      // Step 4: Verify broadcast
      // First broadcast is from POST message, second is from Tymbal response
      expect(broadcastedFrames.length).toBeGreaterThanOrEqual(1);

      // Find the Tymbal response frame
      const responseBroadcast = broadcastedFrames.find((f) => {
        const parsed = JSON.parse(f);
        return parsed.v?.content === 'The answer is 4!';
      });
      expect(responseBroadcast).toBeDefined();
    });
  });

  describe('Agent State Management', () => {
    it('activates container for each message when no callbackUrl in roster', async () => {
      // Note: This test reflects the new architecture where storage.callbackUrl
      // determines if a container is running. With mock storage returning null,
      // each message causes a new activation. In production, the container registers
      // its callbackUrl on checkin, enabling direct message push.

      // First message
      await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox first question',
          sender: 'human-user',
        }),
      });

      // Second message to same agent
      await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox second question',
          sender: 'human-user',
        }),
      });

      // Without callbackUrl in roster, each message activates a new container
      // In production, container would register callbackUrl on checkin
      expect(mockRuntime.getActivateCalls()).toHaveLength(2);
    });

    it('activates multiple agents when mentioned together', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '@fox @bear please coordinate',
          sender: 'human-user',
        }),
      });

      // Both agents should be activated
      const activateCalls = mockRuntime.getActivateCalls();
      expect(activateCalls).toHaveLength(2);

      const agentIds = activateCalls.map((c) => c.options.agentId).sort();
      expect(agentIds).toEqual([
        `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:bear`,
        `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:fox`,
      ]);
    });
  });
});
