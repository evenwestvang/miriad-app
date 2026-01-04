/**
 * Channel & Roster Storage Tests
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
    console.log('⚠️  Skipping Channel/Roster tests: cannot connect to PlanetScale');
    console.log('   Error:', (err as Error).message);
    return false;
  }
}

describe.skipIf(!canConnect)('Channel & Roster Storage', () => {
  let storage: Storage;
  const testSpaceId = 'test-space-002';
  const testRunId = Date.now().toString(36); // Unique suffix per test run
  const createdChannelIds: string[] = [];
  const createdRosterIds: { channelId: string; entryId: string }[] = [];

  // Helper to create unique channel names per test run
  const uniqueName = (base: string) => `${base}-${testRunId}`;

  beforeAll(async () => {
    storage = createPostgresStorage({ connectionString });
    await storage.initialize();
  });

  afterAll(async () => {
    // Clean up test roster entries
    for (const { channelId, entryId } of createdRosterIds) {
      try {
        await storage.removeFromRoster(channelId, entryId);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Clean up test channels
    for (const id of createdChannelIds) {
      try {
        // Delete channel directly via SQL since we don't have a delete method
        // Just archive it for cleanup
        await storage.archiveChannel(testSpaceId, id);
      } catch {
        // Ignore cleanup errors
      }
    }
    await storage.close();
  });

  // ===========================================================================
  // Channel Tests
  // ===========================================================================

  describe('createChannel', () => {
    it('should create a channel and return it with generated id', async () => {
      const name = uniqueName('test-channel');
      const channel = await storage.createChannel({
        spaceId: testSpaceId,
        name,
        tagline: 'A test channel',
        mission: 'Testing the storage layer',
      });

      createdChannelIds.push(channel.id);

      expect(channel.id).toBeDefined();
      expect(channel.id.length).toBe(26); // ULID length
      expect(channel.spaceId).toBe(testSpaceId);
      expect(channel.name).toBe(name);
      expect(channel.tagline).toBe('A test channel');
      expect(channel.mission).toBe('Testing the storage layer');
      expect(channel.archived).toBe(false);
      expect(channel.createdAt).toBeDefined();
      expect(channel.updatedAt).toBeDefined();
    });

    it('should create a channel with minimal fields', async () => {
      const name = uniqueName('minimal-channel');
      const channel = await storage.createChannel({
        spaceId: testSpaceId,
        name,
      });

      createdChannelIds.push(channel.id);

      expect(channel.name).toBe(name);
      expect(channel.tagline).toBeUndefined();
      expect(channel.mission).toBeUndefined();
    });
  });

  describe('getChannel', () => {
    it('should retrieve a channel by id', async () => {
      const name = uniqueName('get-test-channel');
      const created = await storage.createChannel({
        spaceId: testSpaceId,
        name,
      });
      createdChannelIds.push(created.id);

      const retrieved = await storage.getChannel(testSpaceId, created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe(name);
    });

    it('should return null for non-existent channel', async () => {
      const result = await storage.getChannel(testSpaceId, 'nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('getChannelByName', () => {
    it('should retrieve a channel by name', async () => {
      const name = uniqueName('named-channel');
      const created = await storage.createChannel({
        spaceId: testSpaceId,
        name,
        tagline: 'Find me by name',
      });
      createdChannelIds.push(created.id);

      const retrieved = await storage.getChannelByName(testSpaceId, name);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.tagline).toBe('Find me by name');
    });

    it('should return null for non-existent name', async () => {
      const result = await storage.getChannelByName(testSpaceId, 'does-not-exist');
      expect(result).toBeNull();
    });
  });

  describe('listChannels', () => {
    it('should list non-archived channels by default', async () => {
      const name1 = uniqueName('list-channel-1');
      const name2 = uniqueName('list-channel-2');

      const ch1 = await storage.createChannel({
        spaceId: testSpaceId,
        name: name1,
      });
      createdChannelIds.push(ch1.id);

      const ch2 = await storage.createChannel({
        spaceId: testSpaceId,
        name: name2,
      });
      createdChannelIds.push(ch2.id);

      const channels = await storage.listChannels(testSpaceId);

      expect(channels.length).toBeGreaterThanOrEqual(2);
      const names = channels.map((c) => c.name);
      expect(names).toContain(name1);
      expect(names).toContain(name2);
    });

    it('should exclude archived channels by default', async () => {
      const name = uniqueName('archived-channel');
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name,
      });
      createdChannelIds.push(ch.id);

      await storage.archiveChannel(testSpaceId, ch.id);

      const channels = await storage.listChannels(testSpaceId);
      const names = channels.map((c) => c.name);
      expect(names).not.toContain(name);
    });

    it('should include archived channels when requested', async () => {
      // Create a fresh archived channel for this test
      const name = uniqueName('archived-for-include');
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name,
      });
      createdChannelIds.push(ch.id);
      await storage.archiveChannel(testSpaceId, ch.id);

      const channels = await storage.listChannels(testSpaceId, {
        includeArchived: true,
      });

      const names = channels.map((c) => c.name);
      expect(names).toContain(name);
    });
  });

  describe('updateChannel', () => {
    it('should update channel fields', async () => {
      const name = uniqueName('update-test-channel');
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name,
        tagline: 'Original tagline',
      });
      createdChannelIds.push(ch.id);

      await storage.updateChannel(testSpaceId, ch.id, {
        tagline: 'Updated tagline',
        mission: 'New mission',
      });

      const updated = await storage.getChannel(testSpaceId, ch.id);
      expect(updated!.tagline).toBe('Updated tagline');
      expect(updated!.mission).toBe('New mission');
      expect(updated!.name).toBe(name); // unchanged
    });
  });

  describe('archiveChannel', () => {
    it('should archive a channel', async () => {
      const name = uniqueName('to-archive-channel');
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name,
      });
      createdChannelIds.push(ch.id);

      await storage.archiveChannel(testSpaceId, ch.id);

      const archived = await storage.getChannel(testSpaceId, ch.id);
      expect(archived!.archived).toBe(true);
    });
  });

  // ===========================================================================
  // Roster Tests
  // ===========================================================================

  describe('addToRoster', () => {
    it('should add an agent to a roster', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('roster-test-channel'),
      });
      createdChannelIds.push(ch.id);

      const entry = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'fox',
        agentType: 'engineer',
      });

      createdRosterIds.push({ channelId: ch.id, entryId: entry.id });

      expect(entry.id).toBeDefined();
      expect(entry.id.length).toBe(26);
      expect(entry.channelId).toBe(ch.id);
      expect(entry.callsign).toBe('fox');
      expect(entry.agentType).toBe('engineer');
      expect(entry.status).toBe('active');
      expect(entry.createdAt).toBeDefined();
    });

    it('should add an agent with custom status', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('roster-status-channel'),
      });
      createdChannelIds.push(ch.id);

      const entry = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'bear',
        agentType: 'reviewer',
        status: 'idle',
      });

      createdRosterIds.push({ channelId: ch.id, entryId: entry.id });

      expect(entry.status).toBe('idle');
    });
  });

  describe('getRosterEntry', () => {
    it('should retrieve a roster entry by id', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('get-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const created = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'wolf',
        agentType: 'tester',
      });
      createdRosterIds.push({ channelId: ch.id, entryId: created.id });

      const retrieved = await storage.getRosterEntry(ch.id, created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.callsign).toBe('wolf');
    });

    it('should return null for non-existent entry', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('nonexistent-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const result = await storage.getRosterEntry(ch.id, 'nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('getRosterByCallsign', () => {
    it('should retrieve a roster entry by callsign', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('callsign-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const created = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'eagle',
        agentType: 'architect',
      });
      createdRosterIds.push({ channelId: ch.id, entryId: created.id });

      const retrieved = await storage.getRosterByCallsign(ch.id, 'eagle');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.agentType).toBe('architect');
    });

    it('should return null for non-existent callsign', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('no-callsign-channel'),
      });
      createdChannelIds.push(ch.id);

      const result = await storage.getRosterByCallsign(ch.id, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listRoster', () => {
    it('should list all agents in a roster', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('list-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const e1 = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'alpha',
        agentType: 'lead',
      });
      createdRosterIds.push({ channelId: ch.id, entryId: e1.id });

      const e2 = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'beta',
        agentType: 'builder',
      });
      createdRosterIds.push({ channelId: ch.id, entryId: e2.id });

      const roster = await storage.listRoster(ch.id);

      expect(roster.length).toBe(2);
      const callsigns = roster.map((e) => e.callsign);
      expect(callsigns).toContain('alpha');
      expect(callsigns).toContain('beta');
    });
  });

  describe('updateRosterEntry', () => {
    it('should update roster entry status', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('update-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const entry = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'gamma',
        agentType: 'worker',
        status: 'active',
      });
      createdRosterIds.push({ channelId: ch.id, entryId: entry.id });

      await storage.updateRosterEntry(ch.id, entry.id, {
        status: 'busy',
      });

      const updated = await storage.getRosterEntry(ch.id, entry.id);
      expect(updated!.status).toBe('busy');
    });
  });

  describe('removeFromRoster', () => {
    it('should remove an agent from a roster', async () => {
      const ch = await storage.createChannel({
        spaceId: testSpaceId,
        name: uniqueName('remove-roster-channel'),
      });
      createdChannelIds.push(ch.id);

      const entry = await storage.addToRoster({
        channelId: ch.id,
        callsign: 'delta',
        agentType: 'temp',
      });

      await storage.removeFromRoster(ch.id, entry.id);

      const result = await storage.getRosterEntry(ch.id, entry.id);
      expect(result).toBeNull();
    });
  });
});
