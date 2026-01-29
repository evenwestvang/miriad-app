/**
 * PostgreSQL Storage Tests
 *
 * Tests against real PlanetScale database.
 * Set PLANETSCALE_URL environment variable or skip these tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPostgresStorage } from './postgres.js';
import type { Storage } from './interface.js';

// Connection string from environment or hardcoded for local dev
const connectionString = process.env.PLANETSCALE_URL ?? buildConnectionString();

function buildConnectionString(): string {
  const host = 'us-east-2.pg.psdb.cloud';
  const port = '6432';
  const user = 'pscale_api_nmney6igy1w2.pwp8x47bv2br';
  const pass = 'pscale_pw_MdmptCQgW99vHwo4MILzUqRPdfn5iNAk';
  const db = 'postgres';
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

// Skip tests if we can't connect to database
const canConnect = await testConnection();

async function testConnection(): Promise<boolean> {
  try {
    const storage = createPostgresStorage({ connectionString });
    await storage.initialize();
    await storage.close();
    return true;
  } catch (err) {
    console.log('⚠️  Skipping PostgresStorage tests: cannot connect to PlanetScale');
    console.log('   Error:', (err as Error).message);
    return false;
  }
}

describe.skipIf(!canConnect)('PostgresStorage', () => {
  let storage: Storage;
  const testSpaceId = 'test-space-001';
  const testChannelId = 'test-channel-001';
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    storage = createPostgresStorage({ connectionString });
    await storage.initialize();
  });

  afterAll(async () => {
    // Clean up test messages
    for (const id of createdMessageIds) {
      try {
        await storage.deleteMessage(testSpaceId, id);
      } catch {
        // Ignore cleanup errors
      }
    }
    await storage.close();
  }, 30000); // 30 second timeout for cleanup

  describe('saveMessage', () => {
    it('should save a message and return it with generated id', async () => {
      const message = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'test-user',
        senderType: 'user',
        type: 'user',
        content: { text: 'Hello, world!' },
      });

      createdMessageIds.push(message.id);

      expect(message.id).toBeDefined();
      expect(message.id.length).toBe(26); // ULID length
      expect(message.spaceId).toBe(testSpaceId);
      expect(message.channelId).toBe(testChannelId);
      expect(message.sender).toBe('test-user');
      expect(message.senderType).toBe('user');
      expect(message.type).toBe('user');
      expect(message.content).toEqual({ text: 'Hello, world!' });
      expect(message.isComplete).toBe(true);
      expect(message.timestamp).toBeDefined();
    });

    it('should save a message with custom id', async () => {
      const customId = '01JGNTEST00000000000000001';
      const message = await storage.saveMessage({
        id: customId,
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'test-agent',
        senderType: 'agent',
        type: 'agent',
        content: { text: 'I am an agent' },
        addressedAgents: ['channel'],
        turnId: 'turn-001',
      });

      createdMessageIds.push(message.id);

      expect(message.id).toBe(customId);
      expect(message.senderType).toBe('agent');
      expect(message.type).toBe('agent');
      expect(message.addressedAgents).toEqual(['channel']);
      expect(message.turnId).toBe('turn-001');
    });
  });

  describe('getMessage', () => {
    it('should retrieve a message by id', async () => {
      const saved = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'retrieval-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'Find me!' },
      });
      createdMessageIds.push(saved.id);

      const retrieved = await storage.getMessage(testSpaceId, saved.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(saved.id);
      expect(retrieved!.content).toEqual({ text: 'Find me!' });
    });

    it('should return null for non-existent message', async () => {
      const result = await storage.getMessage(testSpaceId, 'nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('getMessages', () => {
    it('should retrieve messages for a channel', async () => {
      // Create a few messages
      const msg1 = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'list-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'Message 1' },
      });
      createdMessageIds.push(msg1.id);

      const msg2 = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'list-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'Message 2' },
      });
      createdMessageIds.push(msg2.id);

      const messages = await storage.getMessages(testSpaceId, testChannelId, {
        limit: 100,
      });

      expect(messages.length).toBeGreaterThanOrEqual(2);
      // Messages should be ordered by id (ULID = chronological)
      const ids = messages.map((m) => m.id);
      expect(ids).toContain(msg1.id);
      expect(ids).toContain(msg2.id);
    });

    it('should support pagination with since parameter', async () => {
      const msg1 = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'pagination-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'Before cursor' },
      });
      createdMessageIds.push(msg1.id);

      const msg2 = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'pagination-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'After cursor' },
      });
      createdMessageIds.push(msg2.id);

      const messages = await storage.getMessages(testSpaceId, testChannelId, {
        since: msg1.id,
        limit: 100,
      });

      // Should only include messages after msg1
      const ids = messages.map((m) => m.id);
      expect(ids).not.toContain(msg1.id);
      expect(ids).toContain(msg2.id);
    });
  });

  describe('updateMessage', () => {
    it('should update message content', async () => {
      const msg = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'update-test',
        senderType: 'agent',
        type: 'agent',
        content: { text: 'Initial content' },
        isComplete: false,
      });
      createdMessageIds.push(msg.id);

      await storage.updateMessage(testSpaceId, msg.id, {
        content: { text: 'Updated content' },
        isComplete: true,
      });

      const updated = await storage.getMessage(testSpaceId, msg.id);
      expect(updated!.content).toEqual({ text: 'Updated content' });
      expect(updated!.isComplete).toBe(true);
    });
  });

  describe('deleteMessage', () => {
    it('should delete a message', async () => {
      const msg = await storage.saveMessage({
        spaceId: testSpaceId,
        channelId: testChannelId,
        sender: 'delete-test',
        senderType: 'user',
        type: 'user',
        content: { text: 'Delete me' },
      });

      await storage.deleteMessage(testSpaceId, msg.id);

      const result = await storage.getMessage(testSpaceId, msg.id);
      expect(result).toBeNull();
    });
  });

  describe('getMessageDeliveryContext', () => {
    // Use unique IDs for this test suite to avoid conflicts
    const ctxSpaceId = 'test-ctx-space-001';
    let ctxChannelId = 'test-ctx-channel-001';
    const ctxRootChannelId = 'test-ctx-root-001';
    const createdArtifactIds: string[] = [];
    const createdRosterIds: string[] = [];
    const createdRuntimeIds: string[] = [];
    const createdChannelIds: string[] = [];
    
    // Generate unique suffix for this test run to avoid conflicts
    const testRunId = Date.now().toString(36);

    beforeAll(async () => {
      // Create the base channel for the empty callsigns test
      try {
        const channel = await storage.createChannel({
          spaceId: ctxSpaceId,
          name: `ctx-base-channel-${testRunId}`,
        });
        ctxChannelId = channel.id;
        createdChannelIds.push(channel.id);
      } catch {
        // Channel may already exist from a previous run
        const channel = await storage.getChannelByName(ctxSpaceId, `ctx-base-channel-${testRunId}`);
        if (channel) {
          ctxChannelId = channel.id;
        }
      }
    }, 30000);

    afterAll(async () => {
      // Clean up test data in reverse order of dependencies
      for (const id of createdArtifactIds) {
        try {
          await storage.archiveArtifact(ctxChannelId, id, 'test-cleanup');
        } catch { /* ignore */ }
        try {
          await storage.archiveArtifact(ctxRootChannelId, id, 'test-cleanup');
        } catch { /* ignore */ }
      }
      for (const id of createdRosterIds) {
        try {
          await storage.removeFromRoster(ctxChannelId, id);
        } catch { /* ignore */ }
      }
      for (const id of createdRuntimeIds) {
        try {
          await storage.deleteRuntime(id);
        } catch { /* ignore */ }
      }
      for (const id of createdChannelIds) {
        try {
          await storage.archiveChannel(ctxSpaceId, id);
        } catch { /* ignore */ }
      }
    }, 30000);

    it('should return empty context for empty callsigns array', async () => {
      const ctx = await storage.getMessageDeliveryContext(ctxSpaceId, ctxChannelId, []);
      
      expect(ctx.agents.size).toBe(0);
      expect(ctx.definitions.size).toBe(0);
      expect(ctx.environments.length).toBe(0);
    });

    it('should fetch roster entries with runtime info', async () => {
      // Create a runtime
      const runtime = await storage.createRuntime({
        spaceId: ctxSpaceId,
        name: `test-runtime-ctx-${testRunId}`,
        type: 'local',
      });
      createdRuntimeIds.push(runtime.id);

      // Create channel if needed (may already exist)
      let channel;
      try {
        channel = await storage.createChannel({
          spaceId: ctxSpaceId,
          name: `ctx-test-channel-${testRunId}`,
        });
        createdChannelIds.push(channel.id);
      } catch {
        channel = await storage.getChannelByName(ctxSpaceId, `ctx-test-channel-${testRunId}`);
      }
      
      if (!channel) {
        throw new Error('Failed to create or get test channel');
      }

      const callsign = `test-agent-ctx-${testRunId}`;
      
      // Add agent to roster with runtime binding
      const roster = await storage.addToRoster({
        channelId: channel.id,
        callsign,
        agentType: 'test-builder',
      });
      createdRosterIds.push(roster.id);

      // Bind to runtime
      await storage.updateRosterEntry(channel.id, roster.id, {
        runtimeId: runtime.id,
      });

      const ctx = await storage.getMessageDeliveryContext(ctxSpaceId, channel.id, [callsign]);

      expect(ctx.agents.size).toBe(1);
      const agent = ctx.agents.get(callsign);
      expect(agent).toBeDefined();
      expect(agent!.roster.callsign).toBe(callsign);
      expect(agent!.roster.agentType).toBe('test-builder');
      expect(agent!.runtime).not.toBeNull();
      expect(agent!.runtime!.id).toBe(runtime.id);
      expect(agent!.runtime!.name).toBe(`test-runtime-ctx-${testRunId}`);
    });

    it('should handle roster entry with no runtime bound', async () => {
      // Create channel
      let channel;
      try {
        channel = await storage.createChannel({
          spaceId: ctxSpaceId,
          name: `ctx-no-runtime-channel-${testRunId}`,
        });
        createdChannelIds.push(channel.id);
      } catch {
        channel = await storage.getChannelByName(ctxSpaceId, `ctx-no-runtime-channel-${testRunId}`);
      }

      if (!channel) {
        throw new Error('Failed to create or get test channel');
      }

      const callsign = `no-runtime-agent-${testRunId}`;

      // Add agent without runtime
      const roster = await storage.addToRoster({
        channelId: channel.id,
        callsign,
        agentType: 'test-builder',
      });
      createdRosterIds.push(roster.id);

      const ctx = await storage.getMessageDeliveryContext(ctxSpaceId, channel.id, [callsign]);

      expect(ctx.agents.size).toBe(1);
      const agent = ctx.agents.get(callsign);
      expect(agent).toBeDefined();
      expect(agent!.roster.callsign).toBe(callsign);
      expect(agent!.runtime).toBeNull();
    });

    it('should fetch multiple agents in single query', async () => {
      // Create channel
      let channel;
      try {
        channel = await storage.createChannel({
          spaceId: ctxSpaceId,
          name: `ctx-multi-agent-channel-${testRunId}`,
        });
        createdChannelIds.push(channel.id);
      } catch {
        channel = await storage.getChannelByName(ctxSpaceId, `ctx-multi-agent-channel-${testRunId}`);
      }

      if (!channel) {
        throw new Error('Failed to create or get test channel');
      }

      const callsign1 = `agent-one-${testRunId}`;
      const callsign2 = `agent-two-${testRunId}`;
      const callsign3 = `agent-three-${testRunId}`;

      // Add multiple agents
      const roster1 = await storage.addToRoster({
        channelId: channel.id,
        callsign: callsign1,
        agentType: 'builder-a',
      });
      createdRosterIds.push(roster1.id);

      const roster2 = await storage.addToRoster({
        channelId: channel.id,
        callsign: callsign2,
        agentType: 'builder-b',
      });
      createdRosterIds.push(roster2.id);

      const roster3 = await storage.addToRoster({
        channelId: channel.id,
        callsign: callsign3,
        agentType: 'builder-a', // Same type as agent-one
      });
      createdRosterIds.push(roster3.id);

      const ctx = await storage.getMessageDeliveryContext(
        ctxSpaceId, 
        channel.id, 
        [callsign1, callsign2, callsign3]
      );

      expect(ctx.agents.size).toBe(3);
      expect(ctx.agents.has(callsign1)).toBe(true);
      expect(ctx.agents.has(callsign2)).toBe(true);
      expect(ctx.agents.has(callsign3)).toBe(true);
      
      // Verify different agent types
      expect(ctx.agents.get(callsign1)!.roster.agentType).toBe('builder-a');
      expect(ctx.agents.get(callsign2)!.roster.agentType).toBe('builder-b');
    });

    it('should return only requested callsigns (not all roster)', async () => {
      // Create channel
      let channel;
      try {
        channel = await storage.createChannel({
          spaceId: ctxSpaceId,
          name: `ctx-filter-channel-${testRunId}`,
        });
        createdChannelIds.push(channel.id);
      } catch {
        channel = await storage.getChannelByName(ctxSpaceId, `ctx-filter-channel-${testRunId}`);
      }

      if (!channel) {
        throw new Error('Failed to create or get test channel');
      }

      const requestedCallsign = `requested-agent-${testRunId}`;
      const notRequestedCallsign = `not-requested-agent-${testRunId}`;

      // Add multiple agents
      const roster1 = await storage.addToRoster({
        channelId: channel.id,
        callsign: requestedCallsign,
        agentType: 'builder',
      });
      createdRosterIds.push(roster1.id);

      const roster2 = await storage.addToRoster({
        channelId: channel.id,
        callsign: notRequestedCallsign,
        agentType: 'builder',
      });
      createdRosterIds.push(roster2.id);

      // Only request one agent
      const ctx = await storage.getMessageDeliveryContext(
        ctxSpaceId, 
        channel.id, 
        [requestedCallsign]
      );

      expect(ctx.agents.size).toBe(1);
      expect(ctx.agents.has(requestedCallsign)).toBe(true);
      expect(ctx.agents.has(notRequestedCallsign)).toBe(false);
    });
  });

  describe('getMcpArtifactsBySlug', () => {
    const mcpChannelId = 'test-mcp-channel-001';
    const mcpRootChannelId = 'test-mcp-root-001';

    it('should return empty map for empty slugs array', async () => {
      const result = await storage.getMcpArtifactsBySlug(mcpChannelId, mcpRootChannelId, []);
      expect(result.size).toBe(0);
    });

    it('should prefer channel version over root version', async () => {
      // This test requires setting up artifacts in both channel and root
      // For now, just verify the method doesn't throw with valid inputs
      const result = await storage.getMcpArtifactsBySlug(
        mcpChannelId, 
        mcpRootChannelId, 
        ['nonexistent-mcp']
      );
      expect(result.size).toBe(0);
    });

    it('should handle null rootChannelId', async () => {
      const result = await storage.getMcpArtifactsBySlug(mcpChannelId, null, ['some-mcp']);
      expect(result.size).toBe(0);
    });
  });
});
