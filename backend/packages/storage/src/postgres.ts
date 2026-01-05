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
  StoredChannel,
  CreateChannelInput,
  UpdateChannelInput,
  ListChannelsParams,
  RosterEntry,
  AddToRosterInput,
  UpdateRosterInput,
  RosterStatus,
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

interface ChannelRow {
  id: string;
  space_id: string;
  name: string;
  tagline: string | null;
  mission: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RosterRow {
  id: string;
  channel_id: string;
  callsign: string;
  agent_type: string;
  status: string;
  created_at: Date;
  callback_url: string | null;
  readmark: string | null;
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
  // Channel Operations (Phase 2)
  // ---------------------------------------------------------------------------

  async function createChannel(input: CreateChannelInput): Promise<StoredChannel> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<ChannelRow[]>`
      INSERT INTO channels (
        id, space_id, name, tagline, mission, archived, created_at, updated_at
      )
      VALUES (
        ${id},
        ${input.spaceId},
        ${input.name},
        ${input.tagline ?? null},
        ${input.mission ?? null},
        false,
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToChannel(result[0]);
  }

  async function getChannel(
    spaceId: string,
    channelId: string
  ): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow[]>`
      SELECT * FROM channels
      WHERE space_id = ${spaceId} AND id = ${channelId}
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function getChannelByName(
    spaceId: string,
    name: string
  ): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow[]>`
      SELECT * FROM channels
      WHERE space_id = ${spaceId} AND name = ${name}
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function listChannels(
    spaceId: string,
    params?: ListChannelsParams
  ): Promise<StoredChannel[]> {
    const limit = params?.limit ?? 100;
    const includeArchived = params?.includeArchived ?? false;

    let result: ChannelRow[];

    if (includeArchived) {
      result = await sql<ChannelRow[]>`
        SELECT * FROM channels
        WHERE space_id = ${spaceId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      result = await sql<ChannelRow[]>`
        SELECT * FROM channels
        WHERE space_id = ${spaceId} AND archived = false
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    return result.map(rowToChannel);
  }

  async function updateChannel(
    spaceId: string,
    channelId: string,
    update: UpdateChannelInput
  ): Promise<void> {
    const updateObj: Record<string, unknown> = {
      updated_at: new Date(),
    };

    if (update.name !== undefined) {
      updateObj.name = update.name;
    }
    if (update.tagline !== undefined) {
      updateObj.tagline = update.tagline;
    }
    if (update.mission !== undefined) {
      updateObj.mission = update.mission;
    }
    if (update.archived !== undefined) {
      updateObj.archived = update.archived;
    }

    await sql`
      UPDATE channels
      SET ${sql(updateObj, ...Object.keys(updateObj))}
      WHERE space_id = ${spaceId} AND id = ${channelId}
    `;
  }

  async function archiveChannel(spaceId: string, channelId: string): Promise<void> {
    await sql`
      UPDATE channels
      SET archived = true, updated_at = ${new Date()}
      WHERE space_id = ${spaceId} AND id = ${channelId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Roster Operations (Phase 2)
  // ---------------------------------------------------------------------------

  async function addToRoster(input: AddToRosterInput): Promise<RosterEntry> {
    const id = input.id ?? ulid();
    const now = new Date();
    const status = input.status ?? 'active';

    const result = await sql<RosterRow[]>`
      INSERT INTO roster (
        id, channel_id, callsign, agent_type, status, created_at
      )
      VALUES (
        ${id},
        ${input.channelId},
        ${input.callsign},
        ${input.agentType},
        ${status},
        ${now}
      )
      RETURNING *
    `;

    return rowToRosterEntry(result[0]);
  }

  async function getRosterEntry(
    channelId: string,
    entryId: string
  ): Promise<RosterEntry | null> {
    const result = await sql<RosterRow[]>`
      SELECT * FROM roster
      WHERE channel_id = ${channelId} AND id = ${entryId}
    `;

    if (result.length === 0) return null;
    return rowToRosterEntry(result[0]);
  }

  async function getRosterByCallsign(
    channelId: string,
    callsign: string
  ): Promise<RosterEntry | null> {
    const result = await sql<RosterRow[]>`
      SELECT * FROM roster
      WHERE channel_id = ${channelId} AND callsign = ${callsign}
    `;

    if (result.length === 0) return null;
    return rowToRosterEntry(result[0]);
  }

  async function listRoster(channelId: string): Promise<RosterEntry[]> {
    const result = await sql<RosterRow[]>`
      SELECT * FROM roster
      WHERE channel_id = ${channelId}
      ORDER BY created_at ASC
    `;

    return result.map(rowToRosterEntry);
  }

  async function updateRosterEntry(
    channelId: string,
    entryId: string,
    update: UpdateRosterInput
  ): Promise<void> {
    // Build update object for postgres.js dynamic columns
    const updateObj: Record<string, unknown> = {};

    if (update.status !== undefined) {
      updateObj.status = update.status;
    }
    if (update.callbackUrl !== undefined) {
      updateObj.callback_url = update.callbackUrl;
    }
    if (update.readmark !== undefined) {
      updateObj.readmark = update.readmark;
    }

    if (Object.keys(updateObj).length === 0) return;

    // Use postgres.js dynamic column updates (same pattern as updateChannel)
    await sql`
      UPDATE roster
      SET ${sql(updateObj, ...Object.keys(updateObj))}
      WHERE channel_id = ${channelId} AND id = ${entryId}
    `;
  }

  async function removeFromRoster(channelId: string, entryId: string): Promise<void> {
    await sql`
      DELETE FROM roster
      WHERE channel_id = ${channelId} AND id = ${entryId}
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

    // Create messages indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(space_id, channel_id, id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_turn
      ON messages(space_id, channel_id, turn_id)
    `;

    // Create channels table (Phase 2)
    await sql`
      CREATE TABLE IF NOT EXISTS channels (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        name VARCHAR(255) NOT NULL,
        tagline TEXT,
        mission TEXT,
        archived BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Create channels indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_channels_space
      ON channels(space_id)
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_space_name
      ON channels(space_id, name)
    `;

    // Create roster table (Phase 2)
    await sql`
      CREATE TABLE IF NOT EXISTS roster (
        id VARCHAR(26) PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        callsign VARCHAR(255) NOT NULL,
        agent_type VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Create roster indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_roster_channel
      ON roster(channel_id)
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_channel_callsign
      ON roster(channel_id, callsign)
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

  function rowToChannel(row: ChannelRow): StoredChannel {
    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      tagline: row.tagline ?? undefined,
      mission: row.mission ?? undefined,
      archived: row.archived,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  function rowToRosterEntry(row: RosterRow): RosterEntry {
    return {
      id: row.id,
      channelId: row.channel_id,
      callsign: row.callsign,
      agentType: row.agent_type,
      status: row.status as RosterStatus,
      createdAt: row.created_at.toISOString(),
      callbackUrl: row.callback_url ?? undefined,
      readmark: row.readmark ?? undefined,
    };
  }

  return {
    // Message operations
    saveMessage,
    getMessage,
    getMessages,
    updateMessage,
    deleteMessage,
    // Channel operations
    createChannel,
    getChannel,
    getChannelByName,
    listChannels,
    updateChannel,
    archiveChannel,
    // Roster operations
    addToRoster,
    getRosterEntry,
    getRosterByCallsign,
    listRoster,
    updateRosterEntry,
    removeFromRoster,
    // Lifecycle
    initialize,
    close,
  };
}
