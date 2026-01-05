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
  });

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
});
