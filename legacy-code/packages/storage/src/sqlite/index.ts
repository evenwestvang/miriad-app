/**
 * SQLite Storage Adapter
 *
 * Local development storage using better-sqlite3.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ulid } from 'ulid';
import type {
  Space,
  Channel,
  RosterEntry,
  StoredMessage,
  ChannelStatus,
  Attachment,
  KBMetadata,
  KBDocument,
  KBSearchOptions,
  KBSearchResult,
  EmbeddingSearchResult,
} from '@cikada/core';
import type {
  Storage,
  CreateSpaceParams,
  CreateChannelParams,
  ListChannelsParams,
  GetMessagesParams,
  GetAgentHistoryParams,
  GetAttachmentsParams,
  EmbeddingSearchOptions,
  SaveStructuredAskParams,
  SubmitStructuredAskParams,
  Artifact,
  ArtifactVersion,
  ArtifactSummary,
  ArtifactTreeNode,
  CreateArtifactInput,
  UpdateArtifactInput,
  ListArtifactsParams,
  CASChange,
  CASResult,
} from '../interface.js';

// =============================================================================
// SQLite Storage Implementation
// =============================================================================

export interface SqliteStorageOptions {
  /** Database file path (or :memory: for in-memory) */
  path: string;
}

export function createSqliteStorage(options: SqliteStorageOptions): Storage {
  const db = new Database(options.path);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Load sqlite-vec extension for vector similarity search
  sqliteVec.load(db);

  // ---------------------------------------------------------------------------
  // Space Operations
  // ---------------------------------------------------------------------------

  async function createSpace(params: CreateSpaceParams): Promise<Space> {
    const now = new Date().toISOString();
    const id = params.id ?? ulid();
    const space: Space = {
      id,
      ownerId: params.ownerId,
      name: params.name,
      createdAt: now,
    };

    db.prepare(`
      INSERT INTO spaces (id, owner_id, name, created_at)
      VALUES (?, ?, ?, ?)
    `).run(space.id, space.ownerId, space.name ?? null, space.createdAt);

    return space;
  }

  async function getSpace(spaceId: string): Promise<Space | null> {
    const row = db.prepare(`
      SELECT id, owner_id, name, created_at
      FROM spaces WHERE id = ?
    `).get(spaceId) as SpaceRow | undefined;

    return row ? rowToSpace(row) : null;
  }

  async function getSpaceByOwnerId(ownerId: string): Promise<Space | null> {
    const row = db.prepare(`
      SELECT id, owner_id, name, created_at
      FROM spaces WHERE owner_id = ?
    `).get(ownerId) as SpaceRow | undefined;

    return row ? rowToSpace(row) : null;
  }

  async function getOrCreateSpace(ownerId: string, name?: string): Promise<Space> {
    // Try to get existing space first
    const existing = await getSpaceByOwnerId(ownerId);
    if (existing) return existing;

    // Create new space
    return createSpace({ ownerId, name });
  }

  async function listSpaces(): Promise<Space[]> {
    const rows = db.prepare(`
      SELECT id, owner_id, name, created_at
      FROM spaces
      ORDER BY created_at DESC
    `).all() as SpaceRow[];

    return rows.map(rowToSpace);
  }

  // ---------------------------------------------------------------------------
  // Channel Operations
  // ---------------------------------------------------------------------------

  async function createChannel(spaceId: string, params: CreateChannelParams): Promise<Channel> {
    const now = new Date().toISOString();
    const channel: Channel = {
      id: params.id,
      spaceId,
      name: params.name,
      description: params.description,
      roster: [],
      leader: params.leader,
      createdAt: now,
      status: 'active',
      focusSlug: params.focusSlug,
      tagline: params.tagline,
      mission: params.mission,
    };

    db.prepare(`
      INSERT INTO channels (id, space_id, name, description, created_at, status, focus_slug, tagline, mission, leader)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      channel.id,
      channel.spaceId,
      channel.name,
      channel.description ?? null,
      channel.createdAt,
      channel.status,
      channel.focusSlug ?? null,
      channel.tagline ?? null,
      channel.mission ?? null,
      channel.leader ?? null
    );

    return channel;
  }

  async function getChannel(spaceId: string, channelId: string): Promise<Channel | null> {
    const row = db.prepare(`
      SELECT id, space_id, name, description, created_at, status, focus_slug, tagline, mission, leader
      FROM channels WHERE space_id = ? AND id = ?
    `).get(spaceId, channelId) as ChannelRow | undefined;

    if (!row) return null;

    // Get roster IDs
    const rosterRows = db.prepare(`
      SELECT participant_id FROM roster WHERE space_id = ? AND channel_id = ?
    `).all(spaceId, channelId) as { participant_id: string }[];

    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      description: row.description ?? undefined,
      roster: rosterRows.map(r => r.participant_id),
      leader: row.leader ?? undefined,
      createdAt: row.created_at,
      status: row.status as ChannelStatus,
      focusSlug: row.focus_slug ?? undefined,
      tagline: row.tagline ?? undefined,
      mission: row.mission ?? undefined,
    };
  }

  async function getChannelByName(spaceId: string, name: string): Promise<Channel | null> {
    const row = db.prepare(`
      SELECT id, space_id, name, description, created_at, status, focus_slug, tagline, mission, leader
      FROM channels WHERE space_id = ? AND name = ?
    `).get(spaceId, name) as ChannelRow | undefined;

    if (!row) return null;

    // Get roster IDs
    const rosterRows = db.prepare(`
      SELECT participant_id FROM roster WHERE space_id = ? AND channel_id = ?
    `).all(spaceId, row.id) as { participant_id: string }[];

    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      description: row.description ?? undefined,
      roster: rosterRows.map(r => r.participant_id),
      leader: row.leader ?? undefined,
      createdAt: row.created_at,
      status: row.status as ChannelStatus,
      focusSlug: row.focus_slug ?? undefined,
      tagline: row.tagline ?? undefined,
      mission: row.mission ?? undefined,
    };
  }

  async function listChannels(spaceId: string, params?: ListChannelsParams): Promise<Channel[]> {
    const includeArchived = params?.includeArchived ?? false;
    const limit = params?.limit ?? 100;

    const rows = db.prepare(`
      SELECT id, space_id, name, description, created_at, status, focus_slug, tagline, mission, leader
      FROM channels
      WHERE space_id = ? ${includeArchived ? '' : "AND status != 'archived'"}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(spaceId, limit) as ChannelRow[];

    return Promise.all(rows.map(async row => {
      const rosterRows = db.prepare(`
        SELECT participant_id FROM roster WHERE space_id = ? AND channel_id = ?
      `).all(spaceId, row.id) as { participant_id: string }[];

      return {
        id: row.id,
        spaceId: row.space_id,
        name: row.name,
        description: row.description ?? undefined,
        roster: rosterRows.map(r => r.participant_id),
        leader: row.leader ?? undefined,
        createdAt: row.created_at,
        status: row.status as ChannelStatus,
        focusSlug: row.focus_slug ?? undefined,
        tagline: row.tagline ?? undefined,
        mission: row.mission ?? undefined,
      };
    }));
  }

  async function updateChannelStatus(spaceId: string, channelId: string, status: ChannelStatus): Promise<void> {
    db.prepare(`
      UPDATE channels SET status = ? WHERE space_id = ? AND id = ?
    `).run(status, spaceId, channelId);
  }

  // ---------------------------------------------------------------------------
  // Roster Operations
  // ---------------------------------------------------------------------------

  async function addToRoster(spaceId: string, channelId: string, entry: RosterEntry): Promise<void> {
    db.prepare(`
      INSERT INTO roster (space_id, channel_id, participant_id, name, type, status, joined_at, agent_config, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      spaceId,
      channelId,
      entry.id,
      entry.name,
      entry.type,
      entry.status,
      entry.joinedAt,
      entry.agentConfig ? JSON.stringify(entry.agentConfig) : null,
      entry.systemPrompt ?? null
    );
  }

  async function removeFromRoster(spaceId: string, channelId: string, participantId: string): Promise<void> {
    db.prepare(`
      DELETE FROM roster WHERE space_id = ? AND channel_id = ? AND participant_id = ?
    `).run(spaceId, channelId, participantId);
  }

  async function getRoster(spaceId: string, channelId: string): Promise<RosterEntry[]> {
    const rows = db.prepare(`
      SELECT participant_id, name, type, status, joined_at, agent_config, system_prompt
      FROM roster WHERE space_id = ? AND channel_id = ?
      ORDER BY joined_at ASC
    `).all(spaceId, channelId) as RosterRow[];

    return rows.map(rowToRosterEntry);
  }

  async function getRosterEntry(spaceId: string, channelId: string, participantId: string): Promise<RosterEntry | null> {
    const row = db.prepare(`
      SELECT participant_id, name, type, status, joined_at, agent_config, system_prompt
      FROM roster WHERE space_id = ? AND channel_id = ? AND participant_id = ?
    `).get(spaceId, channelId, participantId) as RosterRow | undefined;

    return row ? rowToRosterEntry(row) : null;
  }

  async function updateRosterEntry(spaceId: string, channelId: string, participantId: string, update: Partial<RosterEntry>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (update.name !== undefined) {
      sets.push('name = ?');
      values.push(update.name);
    }
    if (update.status !== undefined) {
      sets.push('status = ?');
      values.push(update.status);
    }
    if (update.agentConfig !== undefined) {
      sets.push('agent_config = ?');
      values.push(JSON.stringify(update.agentConfig));
    }

    if (sets.length === 0) return;

    values.push(spaceId, channelId, participantId);

    db.prepare(`
      UPDATE roster SET ${sets.join(', ')} WHERE space_id = ? AND channel_id = ? AND participant_id = ?
    `).run(...values);
  }

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async function saveMessage(spaceId: string, message: StoredMessage): Promise<void> {
    // Extract structured ask fields if present
    const content = message.content as Record<string, unknown>;
    const formData = content?.formData ? JSON.stringify(content.formData) : null;
    const formState = content?.formState as string | undefined ?? null;
    const response = content?.response ? JSON.stringify(content.response) : null;
    const respondedBy = content?.respondedBy as string | undefined ?? null;
    const respondedAt = content?.respondedAt as string | undefined ?? null;

    // Serialize addressedAgents as JSON array
    const addressedAgents = message.addressedAgents ? JSON.stringify(message.addressedAgents) : null;

    db.prepare(`
      INSERT INTO messages (id, space_id, channel_id, sender, sender_type, type, content, timestamp, is_complete, form_data, form_state, response, responded_by, responded_at, addressed_agents, turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      spaceId,
      message.channelId,
      message.sender,
      message.senderType,
      message.type,
      JSON.stringify(message.content),
      message.timestamp,
      message.isComplete ? 1 : 0,
      formData,
      formState,
      response,
      respondedBy,
      respondedAt,
      addressedAgents,
      message.turnId ?? null
    );
  }

  async function getMessage(spaceId: string, messageId: string): Promise<StoredMessage | null> {
    const row = db.prepare(`
      SELECT id, channel_id, sender, sender_type, type, content, timestamp, is_complete,
             form_data, form_state, response, responded_by, responded_at, addressed_agents, turn_id
      FROM messages WHERE space_id = ? AND id = ?
    `).get(spaceId, messageId) as MessageRow | undefined;

    return row ? rowToMessage(row) : null;
  }

  async function getMessages(spaceId: string, channelId: string, params?: GetMessagesParams): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;
    let sql = `
      SELECT id, channel_id, sender, sender_type, type, content, timestamp, is_complete,
             form_data, form_state, response, responded_by, responded_at, addressed_agents, turn_id
      FROM messages
      WHERE space_id = ? AND channel_id = ?
    `;
    const values: unknown[] = [spaceId, channelId];

    // ULID comparison works lexicographically
    if (params?.since) {
      sql += ' AND id > ?';
      values.push(params.since);
    }
    if (params?.before) {
      sql += ' AND id < ?';
      values.push(params.before);
    }

    sql += ' ORDER BY id ASC LIMIT ?';
    values.push(limit);

    const rows = db.prepare(sql).all(...values) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async function updateMessage(spaceId: string, messageId: string, update: Partial<StoredMessage>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (update.content !== undefined) {
      sets.push('content = ?');
      values.push(JSON.stringify(update.content));

      // Also update structured ask fields if present in content
      const content = update.content as Record<string, unknown>;
      if (content?.formData !== undefined) {
        sets.push('form_data = ?');
        values.push(JSON.stringify(content.formData));
      }
      if (content?.formState !== undefined) {
        sets.push('form_state = ?');
        values.push(content.formState);
      }
      if (content?.response !== undefined) {
        sets.push('response = ?');
        values.push(JSON.stringify(content.response));
      }
      if (content?.respondedBy !== undefined) {
        sets.push('responded_by = ?');
        values.push(content.respondedBy);
      }
      if (content?.respondedAt !== undefined) {
        sets.push('responded_at = ?');
        values.push(content.respondedAt);
      }
    }
    if (update.isComplete !== undefined) {
      sets.push('is_complete = ?');
      values.push(update.isComplete ? 1 : 0);
    }

    if (sets.length === 0) return;

    values.push(spaceId, messageId);

    db.prepare(`
      UPDATE messages SET ${sets.join(', ')} WHERE space_id = ? AND id = ?
    `).run(...values);
  }

  async function deleteMessage(spaceId: string, messageId: string): Promise<void> {
    db.prepare('DELETE FROM messages WHERE space_id = ? AND id = ?').run(spaceId, messageId);
  }

  async function getAgentHistory(spaceId: string, channelId: string, params: GetAgentHistoryParams): Promise<StoredMessage[]> {
    const limit = params.limit ?? 100;

    console.log(`[getAgentHistory] spaceId=${spaceId}, channelId=${channelId}, callsign=${params.agentCallsign}, sinceTimestamp=${params.sinceTimestamp}, limit=${limit}`);

    // Query messages where:
    // 1. addressedAgents contains the agent's callsign, OR
    // 2. addressedAgents contains 'channel' (broadcast), OR
    // 3. sender is the agent (agent's own responses)
    // AND timestamp >= sinceTimestamp
    //
    // Since addressedAgents is stored as JSON array, we use JSON functions
    const sql = `
      SELECT id, channel_id, sender, sender_type, type, content, timestamp, is_complete,
             form_data, form_state, response, responded_by, responded_at, addressed_agents, turn_id
      FROM messages
      WHERE space_id = ?
        AND channel_id = ?
        AND timestamp >= ?
        AND (
          (addressed_agents IS NOT NULL AND (
            EXISTS (SELECT 1 FROM json_each(addressed_agents) WHERE value = ?)
            OR EXISTS (SELECT 1 FROM json_each(addressed_agents) WHERE value = 'channel')
          ))
          OR sender = ?
        )
      ORDER BY timestamp ASC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(spaceId, channelId, params.sinceTimestamp, params.agentCallsign, params.agentCallsign, limit) as MessageRow[];
    console.log(`[getAgentHistory] Found ${rows.length} messages`);
    return rows.map(rowToMessage);
  }

  // ---------------------------------------------------------------------------
  // Structured Ask Operations
  // ---------------------------------------------------------------------------

  async function saveStructuredAsk(spaceId: string, params: SaveStructuredAskParams): Promise<StoredMessage> {
    const messageId = ulid();
    const timestamp = new Date().toISOString();

    const content = {
      prompt: params.prompt,
      formData: params.formData,
      formState: 'pending' as const,
    };

    db.prepare(`
      INSERT INTO messages (id, space_id, channel_id, sender, sender_type, type, content, timestamp, is_complete, form_data, form_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      spaceId,
      params.channelId,
      params.sender,
      'agent',
      'structured_ask',
      JSON.stringify(content),
      timestamp,
      1,
      JSON.stringify(params.formData),
      'pending'
    );

    return {
      id: messageId,
      channelId: params.channelId,
      sender: params.sender,
      senderType: 'agent',
      type: 'structured_ask',
      content,
      timestamp,
      isComplete: true,
    };
  }

  async function submitStructuredAskResponse(spaceId: string, params: SubmitStructuredAskParams): Promise<StoredMessage | null> {
    const respondedAt = new Date().toISOString();

    // Use a transaction to ensure atomic update
    const result = db.transaction(() => {
      // Get the current message and check if it's pending
      const row = db.prepare(`
        SELECT id, channel_id, sender, sender_type, type, content, timestamp, is_complete,
               form_data, form_state, response, responded_by, responded_at, addressed_agents
        FROM messages WHERE space_id = ? AND id = ? AND type = 'structured_ask'
      `).get(spaceId, params.messageId) as MessageRow | undefined;

      if (!row) return null;
      if (row.form_state !== 'pending') return null;

      // Update the message atomically
      db.prepare(`
        UPDATE messages
        SET form_state = 'submitted',
            response = ?,
            responded_by = ?,
            responded_at = ?,
            content = ?
        WHERE space_id = ? AND id = ? AND form_state = 'pending'
      `).run(
        JSON.stringify(params.response),
        params.respondedBy,
        respondedAt,
        JSON.stringify({
          ...JSON.parse(row.content),
          formState: 'submitted',
          response: params.response,
          respondedBy: params.respondedBy,
          respondedAt,
        }),
        spaceId,
        params.messageId
      );

      // Return the updated message
      const updatedRow = db.prepare(`
        SELECT id, channel_id, sender, sender_type, type, content, timestamp, is_complete,
               form_data, form_state, response, responded_by, responded_at, addressed_agents
        FROM messages WHERE space_id = ? AND id = ?
      `).get(spaceId, params.messageId) as MessageRow;

      return rowToMessage(updatedRow);
    })();

    return result;
  }

  // ---------------------------------------------------------------------------
  // Attachment Operations
  // ---------------------------------------------------------------------------

  async function saveAttachment(spaceId: string, attachment: Attachment): Promise<void> {
    db.prepare(`
      INSERT INTO attachments (id, space_id, channel_id, message_id, filename, mime_type, size, url, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachment.id,
      spaceId,
      attachment.channelId,
      attachment.messageId ?? null,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      attachment.url,
      attachment.uploadedBy,
      attachment.uploadedAt
    );
  }

  async function getAttachment(spaceId: string, attachmentId: string): Promise<Attachment | null> {
    const row = db.prepare(`
      SELECT id, channel_id, message_id, filename, mime_type, size, url, uploaded_by, uploaded_at
      FROM attachments WHERE space_id = ? AND id = ?
    `).get(spaceId, attachmentId) as AttachmentRow | undefined;

    return row ? rowToAttachment(row) : null;
  }

  async function getAttachments(spaceId: string, channelId: string, params?: GetAttachmentsParams): Promise<Attachment[]> {
    const limit = params?.limit ?? 50;
    let sql = `
      SELECT id, channel_id, message_id, filename, mime_type, size, url, uploaded_by, uploaded_at
      FROM attachments
      WHERE space_id = ? AND channel_id = ?
    `;
    const values: unknown[] = [spaceId, channelId];

    if (params?.uploadedBy) {
      sql += ' AND uploaded_by = ?';
      values.push(params.uploadedBy);
    }

    sql += ' ORDER BY uploaded_at DESC LIMIT ?';
    values.push(limit);

    const rows = db.prepare(sql).all(...values) as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  async function getMessageAttachments(spaceId: string, messageId: string): Promise<Attachment[]> {
    const rows = db.prepare(`
      SELECT id, channel_id, message_id, filename, mime_type, size, url, uploaded_by, uploaded_at
      FROM attachments WHERE space_id = ? AND message_id = ?
      ORDER BY uploaded_at ASC
    `).all(spaceId, messageId) as AttachmentRow[];

    return rows.map(rowToAttachment);
  }

  async function linkAttachmentsToMessage(spaceId: string, messageId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;

    const stmt = db.prepare('UPDATE attachments SET message_id = ? WHERE space_id = ? AND id = ?');
    const updateMany = db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(messageId, spaceId, id);
      }
    });
    updateMany(attachmentIds);
  }

  async function deleteAttachment(spaceId: string, attachmentId: string): Promise<void> {
    db.prepare('DELETE FROM attachments WHERE space_id = ? AND id = ?').run(spaceId, attachmentId);
  }

  // ---------------------------------------------------------------------------
  // Knowledge Base Operations
  // ---------------------------------------------------------------------------

  async function listKnowledgeBases(spaceId: string): Promise<KBMetadata[]> {
    // KB manifests are stored as kb_documents with path = '/'
    const rows = db.prepare(`
      SELECT channel, title, tldr
      FROM kb_documents
      WHERE space_id = ? AND path = '/'
    `).all(spaceId) as { channel: string; title: string; tldr: string }[];

    return rows.map(row => ({
      channel: row.channel,
      title: row.title,
      tldr: row.tldr,
    }));
  }

  async function getKBDocument(spaceId: string, channel: string, path: string): Promise<KBDocument | null> {
    const row = db.prepare(`
      SELECT id, channel, path, slug, title, tldr, content, parent_slug
      FROM kb_documents
      WHERE space_id = ? AND channel = ? AND path = ?
    `).get(spaceId, channel, path) as KBDocumentRow | undefined;

    return row ? rowToKBDocument(row) : null;
  }

  async function searchKB(spaceId: string, channel: string, query: string, options?: KBSearchOptions): Promise<KBSearchResult[]> {
    const limit = options?.limit ?? 10;
    const mode = options?.mode ?? 'keyword';

    if (mode === 'keyword') {
      // FTS5 keyword search with BM25 ranking
      // IMPORTANT: Filter by space_id to prevent cross-space data leakage
      let sql = `
        SELECT
          kb_fts.path,
          kb_fts.title,
          kb_fts.tldr,
          bm25(kb_fts) as rank
        FROM kb_fts
        WHERE kb_fts MATCH ? AND space_id = ? AND channel = ?
      `;
      const params: unknown[] = [query, spaceId, channel];

      if (options?.path) {
        sql += ` AND path LIKE ?`;
        params.push(options.path + '%');
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as {
        path: string;
        title: string;
        tldr: string;
        rank: number;
      }[];

      return rows.map(row => ({
        path: row.path,
        title: row.title,
        tldr: row.tldr,
        // Convert BM25 score (negative, lower is better) to positive relevance
        relevance: -row.rank,
      }));
    }

    // Semantic search is not supported at the storage layer
    // It must be handled at the HTTP layer which has access to embeddingService
    throw new Error(
      'Semantic search mode requested but not supported at storage layer. ' +
      'Use the HTTP API which handles embedding generation.'
    );
  }

  async function indexKBDocument(spaceId: string, doc: KBDocument): Promise<void> {
    // Upsert into kb_documents table
    db.prepare(`
      INSERT INTO kb_documents (id, space_id, channel, path, slug, title, tldr, content, parent_slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id, channel, path) DO UPDATE SET
        id = excluded.id,
        slug = excluded.slug,
        title = excluded.title,
        tldr = excluded.tldr,
        content = excluded.content,
        parent_slug = excluded.parent_slug
    `).run(
      doc.id,
      spaceId,
      doc.channel,
      doc.path,
      doc.slug,
      doc.title,
      doc.tldr,
      doc.content,
      doc.parentSlug ?? null
    );

    // Update FTS5 index (delete then insert for upsert behavior)
    db.prepare(`DELETE FROM kb_fts WHERE doc_id = ?`).run(doc.id);
    db.prepare(`
      INSERT INTO kb_fts (doc_id, space_id, channel, path, slug, title, tldr, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.id,
      spaceId,
      doc.channel,
      doc.path,
      doc.slug,
      doc.title,
      doc.tldr,
      doc.content
    );
  }

  async function removeKBDocument(spaceId: string, channel: string, path: string): Promise<void> {
    // Get doc ID first for FTS cleanup
    const row = db.prepare(`
      SELECT id FROM kb_documents WHERE space_id = ? AND channel = ? AND path = ?
    `).get(spaceId, channel, path) as { id: string } | undefined;

    if (row) {
      db.prepare(`DELETE FROM kb_fts WHERE doc_id = ?`).run(row.id);
      db.prepare(`DELETE FROM kb_documents WHERE id = ?`).run(row.id);
    }
  }

  async function storeEmbedding(spaceId: string, artifactId: string, channel: string, embedding: number[]): Promise<void> {
    if (embedding.length !== 1536) {
      throw new Error(`Expected 1536-dimensional embedding, got ${embedding.length}`);
    }

    // Convert to Float32Array for sqlite-vec
    const float32Embedding = new Float32Array(embedding);

    // Upsert: delete existing then insert
    db.prepare(`DELETE FROM kb_embeddings WHERE space_id = ? AND artifact_id = ?`).run(spaceId, artifactId);
    db.prepare(`
      INSERT INTO kb_embeddings (space_id, artifact_id, channel, embedding)
      VALUES (?, ?, ?, ?)
    `).run(spaceId, artifactId, channel, float32Embedding);
  }

  async function searchByEmbedding(spaceId: string, embedding: number[], options?: EmbeddingSearchOptions): Promise<EmbeddingSearchResult[]> {
    if (embedding.length !== 1536) {
      throw new Error(`Expected 1536-dimensional embedding, got ${embedding.length}`);
    }

    const limit = options?.limit ?? 10;
    const float32Embedding = new Float32Array(embedding);

    let sql = `
      SELECT artifact_id, channel, distance
      FROM kb_embeddings
      WHERE space_id = ? AND embedding MATCH ?
    `;
    const params: unknown[] = [spaceId, float32Embedding];

    if (options?.channel) {
      sql += ` AND channel = ?`;
      params.push(options.channel);
    }

    sql += ` ORDER BY distance LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as {
      artifact_id: string;
      channel: string;
      distance: number;
    }[];

    return rows.map(row => ({
      artifactId: row.artifact_id,
      channel: row.channel,
      distance: row.distance,
    }));
  }

  async function deleteEmbedding(spaceId: string, artifactId: string): Promise<boolean> {
    const result = db.prepare(`DELETE FROM kb_embeddings WHERE space_id = ? AND artifact_id = ?`).run(spaceId, artifactId);
    return result.changes > 0;
  }

  async function hasEmbedding(spaceId: string, artifactId: string): Promise<boolean> {
    const row = db.prepare(`SELECT 1 FROM kb_embeddings WHERE space_id = ? AND artifact_id = ?`).get(spaceId, artifactId);
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // Artifact Operations
  // ---------------------------------------------------------------------------

  function extractRefs(content: string): string[] {
    const pattern = /\[\[([a-z0-9-]+(?:\.[a-z0-9]+)*)\]\]/g;
    const refs: string[] = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      refs.push(match[1]);
    }
    return [...new Set(refs)];
  }

  function computeArtifactPath(spaceId: string, channelId: string, slug: string, parentSlug?: string): string {
    if (!parentSlug) {
      return `/${slug}`;
    }
    const parent = db.prepare(`
      SELECT path FROM artifacts WHERE space_id = ? AND channel_id = ? AND slug = ?
    `).get(spaceId, channelId, parentSlug) as { path: string } | undefined;
    if (!parent) {
      throw new Error(`Parent artifact not found: ${parentSlug}`);
    }
    return `${parent.path}/${slug}`;
  }

  function getDefaultStatus(type: string): string {
    if (type === 'task') return 'pending';
    return 'published';
  }

  function rowToArtifact(row: ArtifactRow): Artifact {
    const props = row.props ? JSON.parse(row.props) : undefined;
    const hasProps = props && Object.keys(props).length > 0;
    return {
      id: row.id,
      slug: row.slug,
      channelId: row.channel_id,
      type: row.type as Artifact['type'],
      title: row.title ?? undefined,
      tldr: row.tldr,
      content: row.content,
      parentSlug: row.parent_slug ?? undefined,
      path: row.path,
      status: row.status as Artifact['status'],
      assignees: JSON.parse(row.assignees || '[]'),
      labels: JSON.parse(row.labels || '[]'),
      refs: JSON.parse(row.refs || '[]'),
      ...(hasProps && { props }),
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedBy: row.updated_by ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  function rowToArtifactSummary(row: ArtifactRow): ArtifactSummary {
    return {
      slug: row.slug,
      path: row.path,
      type: row.type as ArtifactSummary['type'],
      title: row.title ?? undefined,
      status: row.status as ArtifactSummary['status'],
      tldr: row.tldr,
      assignees: JSON.parse(row.assignees || '[]'),
    };
  }

  async function createArtifact(spaceId: string, channelId: string, input: CreateArtifactInput): Promise<Artifact> {
    const now = new Date().toISOString();
    const id = ulid();
    const path = computeArtifactPath(spaceId, channelId, input.slug, input.parentSlug);
    const refs = extractRefs(input.content);
    const status = input.status ?? getDefaultStatus(input.type);
    const assignees = input.assignees ?? [];
    const labels = input.labels ?? [];
    const props = input.props ?? {};

    try {
      db.prepare(`
        INSERT INTO artifacts (
          id, space_id, channel_id, slug, type, title, tldr, content, parent_slug, path,
          status, assignees, labels, refs, props, version, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        spaceId,
        channelId,
        input.slug,
        input.type,
        input.title ?? null,
        input.tldr,
        input.content,
        input.parentSlug ?? null,
        path,
        status,
        JSON.stringify(assignees),
        JSON.stringify(labels),
        JSON.stringify(refs),
        JSON.stringify(props),
        input.createdBy,
        now
      );
    } catch (err: unknown) {
      if ((err as Error).message?.includes('UNIQUE constraint')) {
        throw new Error(`Artifact already exists: ${input.slug}`);
      }
      throw err;
    }

    const hasProps = Object.keys(props).length > 0;
    return {
      id,
      slug: input.slug,
      channelId,
      type: input.type,
      title: input.title,
      tldr: input.tldr,
      content: input.content,
      parentSlug: input.parentSlug,
      path,
      status: status as Artifact['status'],
      assignees,
      labels,
      refs,
      ...(hasProps && { props }),
      version: 1,
      createdBy: input.createdBy,
      createdAt: now,
    };
  }

  async function getArtifact(spaceId: string, channelId: string, slug: string): Promise<Artifact | null> {
    const row = db.prepare(`
      SELECT * FROM artifacts WHERE space_id = ? AND channel_id = ? AND slug = ?
    `).get(spaceId, channelId, slug) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  async function updateArtifact(
    spaceId: string,
    channelId: string,
    slug: string,
    update: UpdateArtifactInput,
    updatedBy: string
  ): Promise<Artifact> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_by = ?', 'updated_at = ?', 'version = version + 1'];
    const values: unknown[] = [updatedBy, now];

    if (update.content !== undefined) {
      sets.push('content = ?', 'refs = ?');
      values.push(update.content, JSON.stringify(extractRefs(update.content)));
    }
    if (update.title !== undefined) {
      sets.push('title = ?');
      values.push(update.title);
    }
    if (update.tldr !== undefined) {
      sets.push('tldr = ?');
      values.push(update.tldr);
    }
    if (update.status !== undefined) {
      sets.push('status = ?');
      values.push(update.status);
    }
    if (update.assignees !== undefined) {
      sets.push('assignees = ?');
      values.push(JSON.stringify(update.assignees));
    }
    if (update.labels !== undefined) {
      sets.push('labels = ?');
      values.push(JSON.stringify(update.labels));
    }
    if (update.props !== undefined) {
      sets.push('props = ?');
      values.push(JSON.stringify(update.props));
    }
    if (update.parentSlug !== undefined) {
      const newPath = computeArtifactPath(spaceId, channelId, slug, update.parentSlug ?? undefined);
      sets.push('parent_slug = ?', 'path = ?');
      values.push(update.parentSlug, newPath);
    }

    values.push(spaceId, channelId, slug);

    const result = db.prepare(`
      UPDATE artifacts SET ${sets.join(', ')}
      WHERE space_id = ? AND channel_id = ? AND slug = ?
    `).run(...values);

    if (result.changes === 0) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const updated = await getArtifact(spaceId, channelId, slug);
    if (!updated) throw new Error(`Artifact not found after update: ${slug}`);
    return updated;
  }

  // Normalize values for CAS comparison: treat null and undefined as equivalent
  function normalizeCASValue(value: unknown): unknown {
    if (value === undefined || value === null) {
      return null;
    }
    return value;
  }

  async function updateArtifactWithCAS(
    spaceId: string,
    channelId: string,
    slug: string,
    changes: CASChange[],
    updatedBy: string
  ): Promise<CASResult> {
    const artifact = await getArtifact(spaceId, channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Verify all CAS conditions
    for (const change of changes) {
      const currentValue = normalizeCASValue(artifact[change.field]);
      const expectedValue = normalizeCASValue(change.oldValue);
      const currentStr = JSON.stringify(currentValue);
      const expectedStr = JSON.stringify(expectedValue);

      if (currentStr !== expectedStr) {
        return {
          success: false,
          conflict: {
            field: change.field,
            expected: change.oldValue,
            actual: artifact[change.field],
          },
        };
      }
    }

    // Apply changes
    const updateInput: UpdateArtifactInput = {};
    for (const change of changes) {
      (updateInput as Record<string, unknown>)[change.field] = change.newValue;
    }

    const updated = await updateArtifact(spaceId, channelId, slug, updateInput, updatedBy);
    return { success: true, artifact: updated };
  }

  async function archiveArtifact(spaceId: string, channelId: string, slug: string, updatedBy: string): Promise<Artifact> {
    return updateArtifact(spaceId, channelId, slug, { status: 'archived' }, updatedBy);
  }

  async function listArtifacts(spaceId: string, channelId: string, filters?: ListArtifactsParams): Promise<ArtifactSummary[]> {
    const conditions: string[] = ['space_id = ?', 'channel_id = ?'];
    const values: unknown[] = [spaceId, channelId];

    if (filters?.type) {
      conditions.push('type = ?');
      values.push(filters.type);
    }
    if (filters?.status) {
      conditions.push('status = ?');
      values.push(filters.status);
    } else {
      conditions.push("status != 'archived'");
    }
    if (filters?.assignee) {
      conditions.push('assignees LIKE ?');
      values.push(`%"${filters.assignee}"%`);
    }
    if (filters?.parentSlug === 'root') {
      conditions.push('parent_slug IS NULL');
    } else if (filters?.parentSlug) {
      conditions.push('parent_slug = ?');
      values.push(filters.parentSlug);
    }
    if (filters?.search) {
      conditions.push('(slug LIKE ? OR title LIKE ? OR tldr LIKE ? OR content LIKE ?)');
      const searchPattern = `%${filters.search}%`;
      values.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    values.push(limit, offset);

    const rows = db.prepare(`
      SELECT slug, path, type, title, status, tldr, assignees
      FROM artifacts
      WHERE ${conditions.join(' AND ')}
      ORDER BY path ASC
      LIMIT ? OFFSET ?
    `).all(...values) as ArtifactRow[];

    return rows.map(rowToArtifactSummary);
  }

  async function globArtifacts(spaceId: string, channelId: string, pattern: string): Promise<ArtifactTreeNode[]> {
    let sqlPattern: string;
    let parentIsRoot = false;

    if (pattern === '/**') {
      sqlPattern = '/%';
    } else if (pattern === '/*') {
      parentIsRoot = true;
      sqlPattern = '/%';
    } else if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3);
      sqlPattern = `${base}%`;
    } else if (pattern.includes('*')) {
      sqlPattern = pattern.replace(/\*/g, '%');
    } else {
      sqlPattern = pattern;
    }

    let query: string;
    const values: unknown[] = [spaceId, channelId];

    if (parentIsRoot) {
      query = `
        SELECT slug, path, type, title, status, assignees, parent_slug
        FROM artifacts
        WHERE space_id = ? AND channel_id = ? AND parent_slug IS NULL AND status != 'archived'
        ORDER BY path ASC
      `;
    } else {
      query = `
        SELECT slug, path, type, title, status, assignees, parent_slug
        FROM artifacts
        WHERE space_id = ? AND channel_id = ? AND path LIKE ? AND status != 'archived'
        ORDER BY path ASC
      `;
      values.push(sqlPattern);
    }

    const rows = db.prepare(query).all(...values) as (ArtifactRow & { parent_slug: string | null })[];

    // Build tree structure
    const nodeMap = new Map<string, ArtifactTreeNode>();
    const rootNodes: ArtifactTreeNode[] = [];

    for (const row of rows) {
      const node: ArtifactTreeNode = {
        slug: row.slug,
        path: row.path,
        type: row.type as ArtifactTreeNode['type'],
        title: row.title ?? undefined,
        status: row.status as ArtifactTreeNode['status'],
        assignees: JSON.parse(row.assignees || '[]'),
        children: [],
      };
      nodeMap.set(node.slug, node);
    }

    for (const row of rows) {
      const node = nodeMap.get(row.slug)!;
      if (row.parent_slug && nodeMap.has(row.parent_slug)) {
        nodeMap.get(row.parent_slug)!.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    return rootNodes;
  }

  async function checkpointArtifact(
    spaceId: string,
    channelId: string,
    slug: string,
    versionName: string,
    message: string | undefined,
    createdBy: string
  ): Promise<ArtifactVersion> {
    const artifact = await getArtifact(spaceId, channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO artifact_versions (space_id, channel_id, slug, version_name, version_message, version_created_at, version_created_by, tldr, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(spaceId, channelId, slug, versionName, message ?? null, now, createdBy, artifact.tldr, artifact.content);

    return {
      slug,
      versionName,
      versionMessage: message,
      versionCreatedAt: now,
      versionCreatedBy: createdBy,
      tldr: artifact.tldr,
      content: artifact.content,
    };
  }

  async function getArtifactVersion(
    spaceId: string,
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null> {
    const row = db.prepare(`
      SELECT slug, version_name, version_message, version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE space_id = ? AND channel_id = ? AND slug = ? AND version_name = ?
    `).get(spaceId, channelId, slug, versionName) as ArtifactVersionRow | undefined;

    if (!row) return null;

    return {
      slug: row.slug,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      versionCreatedAt: row.version_created_at,
      versionCreatedBy: row.version_created_by,
      tldr: row.tldr,
      content: row.content,
    };
  }

  async function listArtifactVersions(spaceId: string, channelId: string, slug: string): Promise<ArtifactVersion[]> {
    const rows = db.prepare(`
      SELECT slug, version_name, version_message, version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE space_id = ? AND channel_id = ? AND slug = ?
      ORDER BY version_created_at DESC
    `).all(spaceId, channelId, slug) as ArtifactVersionRow[];

    return rows.map(row => ({
      slug: row.slug,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      versionCreatedAt: row.version_created_at,
      versionCreatedBy: row.version_created_by,
      tldr: row.tldr,
      content: row.content,
    }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    db.exec(`
      -- Spaces table (multi-tenancy)
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (owner_id)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        focus_slug TEXT,
        tagline TEXT,
        mission TEXT,
        leader TEXT,
        PRIMARY KEY (space_id, id),
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS roster (
        space_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        joined_at TEXT NOT NULL,
        agent_config TEXT,
        system_prompt TEXT,
        PRIMARY KEY (space_id, channel_id, participant_id),
        FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 1,
        form_data TEXT,
        form_state TEXT,
        response TEXT,
        responded_by TEXT,
        responded_at TEXT,
        addressed_agents TEXT,
        turn_id TEXT,
        FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_space_channel ON messages(space_id, channel_id, id);
      CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(space_id, channel_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_roster_space_channel ON roster(space_id, channel_id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        url TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_space_channel ON attachments(space_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

      -- Knowledge Base FTS5 table for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        doc_id,
        space_id,
        channel,
        path,
        slug,
        title,
        tldr,
        content,
        tokenize='porter'
      );

      -- Knowledge Base documents table
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        path TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        tldr TEXT NOT NULL,
        content TEXT NOT NULL,
        parent_slug TEXT,
        UNIQUE(space_id, channel, path)
      );

      CREATE INDEX IF NOT EXISTS idx_kb_documents_space_channel ON kb_documents(space_id, channel);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_path ON kb_documents(channel, path);

      -- Artifacts table
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        tldr TEXT NOT NULL,
        content TEXT NOT NULL,
        parent_slug TEXT,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        assignees TEXT DEFAULT '[]',
        labels TEXT DEFAULT '[]',
        refs TEXT DEFAULT '[]',
        props TEXT DEFAULT '{}',
        version INTEGER DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT,
        UNIQUE(space_id, channel_id, slug),
        FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_space_channel ON artifacts(space_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(space_id, channel_id, type);
      CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(space_id, channel_id, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(space_id, channel_id, path);

      -- Artifact versions table (for checkpoints)
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        space_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        version_name TEXT NOT NULL,
        version_message TEXT,
        version_created_at TEXT NOT NULL,
        version_created_by TEXT NOT NULL,
        tldr TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(space_id, channel_id, slug, version_name),
        FOREIGN KEY (space_id, channel_id, slug) REFERENCES artifacts(space_id, channel_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(space_id, channel_id, slug);
    `);

    // Create sqlite-vec embeddings table (vec0 virtual table)
    // Note: vec0 virtual tables don't support additional columns in the same way
    // We'll use a composite key pattern with spaceId:artifactId
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_embeddings USING vec0(
        artifact_id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        embedding FLOAT[1536]
      );
    `);

    // Migrations for existing databases
    // Add leader column to channels table if it doesn't exist
    const channelColumns = db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[];
    if (!channelColumns.some(col => col.name === 'leader')) {
      db.exec(`ALTER TABLE channels ADD COLUMN leader TEXT`);
    }

    // Add addressed_agents column to messages table if it doesn't exist
    const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!messageColumns.some(col => col.name === 'addressed_agents')) {
      db.exec(`ALTER TABLE messages ADD COLUMN addressed_agents TEXT`);
    }

    // Add system_prompt column to roster table if it doesn't exist
    const rosterColumns = db.prepare(`PRAGMA table_info(roster)`).all() as { name: string }[];
    if (!rosterColumns.some(col => col.name === 'system_prompt')) {
      // Handle migration from old column name
      if (rosterColumns.some(col => col.name === 'cached_system_prompt')) {
        db.exec(`ALTER TABLE roster RENAME COLUMN cached_system_prompt TO system_prompt`);
      } else {
        db.exec(`ALTER TABLE roster ADD COLUMN system_prompt TEXT`);
      }
    }
  }

  async function close(): Promise<void> {
    db.close();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rowToSpace(row: SpaceRow): Space {
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name ?? undefined,
      createdAt: row.created_at,
    };
  }

  function rowToRosterEntry(row: RosterRow): RosterEntry {
    return {
      id: row.participant_id,
      name: row.name,
      type: row.type as RosterEntry['type'],
      status: row.status as RosterEntry['status'],
      joinedAt: row.joined_at,
      agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
      systemPrompt: row.system_prompt ?? undefined,
    };
  }

  function rowToMessage(row: MessageRow): StoredMessage {
    let content = JSON.parse(row.content);

    // For structured_ask messages, reconstruct the full content from dedicated columns
    if (row.type === 'structured_ask' && row.form_data) {
      content = {
        ...content,
        formData: JSON.parse(row.form_data),
        formState: row.form_state,
        ...(row.response && { response: JSON.parse(row.response) }),
        ...(row.responded_by && { respondedBy: row.responded_by }),
        ...(row.responded_at && { respondedAt: row.responded_at }),
      };
    }

    return {
      id: row.id,
      channelId: row.channel_id,
      sender: row.sender,
      senderType: row.sender_type as StoredMessage['senderType'],
      type: row.type as StoredMessage['type'],
      content,
      timestamp: row.timestamp,
      isComplete: row.is_complete === 1,
      addressedAgents: row.addressed_agents ? JSON.parse(row.addressed_agents) : undefined,
      turnId: row.turn_id ?? undefined,
    };
  }

  function rowToAttachment(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      channelId: row.channel_id,
      messageId: row.message_id ?? undefined,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      url: row.url,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.uploaded_at,
    };
  }

  function rowToKBDocument(row: KBDocumentRow): KBDocument {
    return {
      id: row.id,
      channel: row.channel,
      path: row.path,
      slug: row.slug,
      title: row.title,
      tldr: row.tldr,
      content: row.content,
      parentSlug: row.parent_slug ?? undefined,
    };
  }

  return {
    // Space operations
    createSpace,
    getSpace,
    getSpaceByOwnerId,
    getOrCreateSpace,
    listSpaces,
    // Channel operations
    createChannel,
    getChannel,
    getChannelByName,
    listChannels,
    updateChannelStatus,
    // Roster operations
    addToRoster,
    removeFromRoster,
    getRoster,
    getRosterEntry,
    updateRosterEntry,
    // Message operations
    saveMessage,
    getMessage,
    getMessages,
    updateMessage,
    deleteMessage,
    getAgentHistory,
    // Structured ask operations
    saveStructuredAsk,
    submitStructuredAskResponse,
    // Attachment operations
    saveAttachment,
    getAttachment,
    getAttachments,
    getMessageAttachments,
    linkAttachmentsToMessage,
    deleteAttachment,
    // Knowledge base operations
    listKnowledgeBases,
    getKBDocument,
    searchKB,
    indexKBDocument,
    removeKBDocument,
    storeEmbedding,
    searchByEmbedding,
    deleteEmbedding,
    hasEmbedding,
    // Artifact operations
    createArtifact,
    getArtifact,
    updateArtifact,
    updateArtifactWithCAS,
    archiveArtifact,
    listArtifacts,
    globArtifacts,
    checkpointArtifact,
    getArtifactVersion,
    listArtifactVersions,
    // Lifecycle
    initialize,
    close,
  };
}

// =============================================================================
// Row Types
// =============================================================================

interface SpaceRow {
  id: string;
  owner_id: string;
  name: string | null;
  created_at: string;
}

interface ChannelRow {
  id: string;
  space_id: string;
  name: string;
  description: string | null;
  created_at: string;
  status: string;
  focus_slug: string | null;
  tagline: string | null;
  mission: string | null;
  leader: string | null;
}

interface RosterRow {
  participant_id: string;
  name: string;
  type: string;
  status: string;
  joined_at: string;
  agent_config: string | null;
  system_prompt: string | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender: string;
  sender_type: string;
  type: string;
  content: string;
  timestamp: string;
  is_complete: number;
  form_data: string | null;
  form_state: string | null;
  response: string | null;
  responded_by: string | null;
  responded_at: string | null;
  addressed_agents: string | null;
  turn_id: string | null;
}

interface AttachmentRow {
  id: string;
  channel_id: string;
  message_id: string | null;
  filename: string;
  mime_type: string;
  size: number;
  url: string;
  uploaded_by: string;
  uploaded_at: string;
}

interface KBDocumentRow {
  id: string;
  channel: string;
  path: string;
  slug: string;
  title: string;
  tldr: string;
  content: string;
  parent_slug: string | null;
}

interface ArtifactRow {
  id: string;
  space_id: string;
  channel_id: string;
  slug: string;
  type: string;
  title: string | null;
  tldr: string;
  content: string;
  parent_slug: string | null;
  path: string;
  status: string;
  assignees: string;
  labels: string;
  refs: string;
  props: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

interface ArtifactVersionRow {
  slug: string;
  version_name: string;
  version_message: string | null;
  version_created_at: string;
  version_created_by: string;
  tldr: string;
  content: string;
}
