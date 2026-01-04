/**
 * PostgreSQL Storage Implementation
 *
 * Uses @neondatabase/serverless for PlanetScale Postgres.
 * Works in serverless environments (Lambda, Edge).
 */

import { neon } from '@neondatabase/serverless';
import { ulid } from 'ulid';
import type {
  StoredMessage,
  CreateMessageInput,
  GetMessagesParams,
} from '@cast/core';
import type { Storage } from './interface.js';

// =============================================================================
// Types
// =============================================================================

export interface PostgresStorageOptions {
  /** PostgreSQL connection string */
  connectionString: string;
}

// Row type from database
interface MessageRow {
  id: string;
  space_id: string;
  channel_id: string;
  sender: string;
  sender_type: string;
  type: string;
  content: string;
  timestamp: string;
  is_complete: boolean;
  addressed_agents: string[] | null;
  turn_id: string | null;
  metadata: Record<string, unknown> | null;
}

// =============================================================================
// PostgreSQL Storage Implementation
// =============================================================================

export function createPostgresStorage(options: PostgresStorageOptions): Storage {
  // Note: fetchConnectionCache is now always true by default in @neondatabase/serverless

  const sql = neon(options.connectionString);

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async function saveMessage(input: CreateMessageInput): Promise<StoredMessage> {
    const id = input.id ?? ulid();
    const timestamp = new Date().toISOString();
    const isComplete = input.isComplete ?? true;

    const result = await sql`
      INSERT INTO messages (
        id, space_id, channel_id, sender, sender_type, type, content,
        timestamp, is_complete, addressed_agents, turn_id, metadata
      )
      VALUES (
        ${id},
        ${input.spaceId},
        ${input.channelId},
        ${input.sender},
        ${input.senderType},
        ${input.type},
        ${JSON.stringify(input.content)},
        ${timestamp},
        ${isComplete},
        ${input.addressedAgents ?? null},
        ${input.turnId ?? null},
        ${input.metadata ? JSON.stringify(input.metadata) : null}
      )
      RETURNING *
    `;

    return rowToMessage(result[0] as MessageRow);
  }

  async function getMessage(
    spaceId: string,
    messageId: string
  ): Promise<StoredMessage | null> {
    const result = await sql`
      SELECT * FROM messages
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;

    if (result.length === 0) return null;
    return rowToMessage(result[0] as MessageRow);
  }

  async function getMessages(
    spaceId: string,
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;

    let result;

    if (params?.since && params?.before) {
      result = await sql`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${params.since}
          AND id < ${params.before}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (params?.since) {
      result = await sql`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${params.since}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (params?.before) {
      result = await sql`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id < ${params.before}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else {
      result = await sql`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    }

    return result.map((row) => rowToMessage(row as MessageRow));
  }

  async function updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<StoredMessage>
  ): Promise<void> {
    // Build dynamic update - only update provided fields
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (update.content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      values.push(JSON.stringify(update.content));
    }
    if (update.isComplete !== undefined) {
      updates.push(`is_complete = $${paramIndex++}`);
      values.push(update.isComplete);
    }
    if (update.addressedAgents !== undefined) {
      updates.push(`addressed_agents = $${paramIndex++}`);
      values.push(update.addressedAgents);
    }
    if (update.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(update.metadata));
    }

    if (updates.length === 0) return;

    // Use raw query for dynamic updates
    const query = `
      UPDATE messages
      SET ${updates.join(', ')}
      WHERE space_id = $${paramIndex++} AND id = $${paramIndex++}
    `;
    values.push(spaceId, messageId);

    await sql.query(query, values);
  }

  async function deleteMessage(spaceId: string, messageId: string): Promise<void> {
    await sql`
      DELETE FROM messages
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    // Create messages table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        channel_id VARCHAR(26) NOT NULL,
        sender VARCHAR(255) NOT NULL,
        sender_type VARCHAR(50) NOT NULL,
        type VARCHAR(50) NOT NULL,
        content JSONB NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_complete BOOLEAN NOT NULL DEFAULT true,
        addressed_agents TEXT[],
        turn_id VARCHAR(26),
        metadata JSONB
      )
    `;

    // Create indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(space_id, channel_id, id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_turn
      ON messages(space_id, channel_id, turn_id)
    `;
  }

  async function close(): Promise<void> {
    // neon client doesn't need explicit close
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rowToMessage(row: MessageRow): StoredMessage {
    return {
      id: row.id,
      spaceId: row.space_id,
      channelId: row.channel_id,
      sender: row.sender,
      senderType: row.sender_type as StoredMessage['senderType'],
      type: row.type as StoredMessage['type'],
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
      timestamp: row.timestamp,
      isComplete: row.is_complete,
      addressedAgents: row.addressed_agents ?? undefined,
      turnId: row.turn_id ?? undefined,
      metadata: row.metadata ?? undefined,
    };
  }

  return {
    saveMessage,
    getMessage,
    getMessages,
    updateMessage,
    deleteMessage,
    initialize,
    close,
  };
}
