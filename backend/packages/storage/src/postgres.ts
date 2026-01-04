/**
 * PostgreSQL Storage Implementation
 *
 * Uses postgres (porsager/postgres) for PlanetScale Postgres.
 * Standard TCP/TLS connection that works everywhere.
 */

import postgres from 'postgres';
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
  content: unknown;
  timestamp: Date;
  is_complete: boolean;
  addressed_agents: string[] | null;
  turn_id: string | null;
  metadata: Record<string, unknown> | null;
}

// =============================================================================
// PostgreSQL Storage Implementation
// =============================================================================

export function createPostgresStorage(options: PostgresStorageOptions): Storage {
  const sql = postgres(options.connectionString, {
    ssl: 'require',
    max: 10, // connection pool size
  });

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async function saveMessage(input: CreateMessageInput): Promise<StoredMessage> {
    const id = input.id ?? ulid();
    const timestamp = new Date();
    const isComplete = input.isComplete ?? true;

    const result = await sql<MessageRow[]>`
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

    return rowToMessage(result[0]);
  }

  async function getMessage(
    spaceId: string,
    messageId: string
  ): Promise<StoredMessage | null> {
    const result = await sql<MessageRow[]>`
      SELECT * FROM messages
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;

    if (result.length === 0) return null;
    return rowToMessage(result[0]);
  }

  async function getMessages(
    spaceId: string,
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;

    let result: MessageRow[];

    if (params?.since && params?.before) {
      result = await sql<MessageRow[]>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${params.since}
          AND id < ${params.before}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (params?.since) {
      result = await sql<MessageRow[]>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${params.since}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (params?.before) {
      result = await sql<MessageRow[]>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id < ${params.before}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else {
      result = await sql<MessageRow[]>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    }

    return result.map(rowToMessage);
  }

  async function updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<StoredMessage>
  ): Promise<void> {
    // Build update object for postgres.js
    const updateObj: Record<string, unknown> = {};

    if (update.content !== undefined) {
      updateObj.content = JSON.stringify(update.content);
    }
    if (update.isComplete !== undefined) {
      updateObj.is_complete = update.isComplete;
    }
    if (update.addressedAgents !== undefined) {
      updateObj.addressed_agents = update.addressedAgents;
    }
    if (update.metadata !== undefined) {
      updateObj.metadata = JSON.stringify(update.metadata);
    }

    if (Object.keys(updateObj).length === 0) return;

    // Use postgres.js dynamic column updates
    await sql`
      UPDATE messages
      SET ${sql(updateObj, ...Object.keys(updateObj))}
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;
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
    await sql.end();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rowToMessage(row: MessageRow): StoredMessage {
    // Parse JSONB content if it comes back as a string
    let content = row.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        // Keep as string if not valid JSON
      }
    }

    // Parse metadata if it comes back as a string
    let metadata = row.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }

    return {
      id: row.id,
      spaceId: row.space_id,
      channelId: row.channel_id,
      sender: row.sender,
      senderType: row.sender_type as StoredMessage['senderType'],
      type: row.type as StoredMessage['type'],
      content,
      timestamp: row.timestamp.toISOString(),
      isComplete: row.is_complete,
      addressedAgents: row.addressed_agents ?? undefined,
      turnId: row.turn_id ?? undefined,
      metadata: metadata ?? undefined,
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
