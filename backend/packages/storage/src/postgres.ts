/**
 * PostgreSQL Storage Implementation
 *
 * Uses postgres (porsager/postgres) for PlanetScale Postgres.
 * Standard TCP/TLS connection that works everywhere.
 */

import postgres, { JSONValue } from 'postgres';
import crypto from 'crypto';
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
  // User/Space types (Spaces & Auth)
  StoredUser,
  CreateUserInput,
  StoredSpace,
  CreateSpaceInput,
  // Artifact types (Phase A)
  StoredArtifact,
  CreateArtifactInput,
  ArtifactCASChange,
  ArtifactCASResult,
  ArtifactEditInput,
  ListArtifactsParams,
  ArtifactSummary,
  ArtifactTreeNode,
  ArtifactVersion,
  CreateArtifactVersionInput,
  ArtifactType,
  ArtifactStatus,
  RecursiveArchiveResult,
  ArchivedItem,
  // Secrets types (App Integrations)
  SecretMetadata,
  StoredSecret,
  // Local Agent Server types (Stage 3)
  StoredLocalAgentServer,
  CreateLocalAgentServerInput,
} from '@cast/core';
// Import functions separately (not as types)
import {
  extractRefs,
  getDefaultArtifactStatus,
  slugToPathSegment,
} from '@cast/core';
import type { Storage, SetSecretInput } from './interface.js';

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

interface UserRow {
  id: string;
  external_id: string;
  callsign: string;
  email: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SpaceRow {
  id: string;
  owner_id: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ArtifactRow {
  id: string;
  channel_id: string;
  slug: string;
  type: string;
  title: string | null;
  tldr: string | null;
  content: string;
  parent_slug: string | null;
  path: string;
  order_key: string;
  status: string;
  assignees: string[];
  labels: string[];
  refs: string[];
  props: Record<string, unknown> | null;
  secrets: Record<string, StoredSecret> | null;
  content_type: string | null;
  file_size: number | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date | null;
}

interface ArtifactVersionRow {
  slug: string;
  channel_id: string;
  version_name: string;
  version_message: string | null;
  version_created_at: Date;
  version_created_by: string;
  tldr: string;
  content: string;
}

interface LocalAgentServerRow {
  server_id: string;
  space_id: string;
  user_id: string;
  secret: string;
  created_at: Date;
  revoked_at: Date | null;
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

  async function getChannelById(channelId: string): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow[]>`
      SELECT * FROM channels
      WHERE id = ${channelId}
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
  // User Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  function rowToUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      externalId: row.external_id,
      callsign: row.callsign,
      email: row.email ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  function rowToSpace(row: SpaceRow): StoredSpace {
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async function createUser(input: CreateUserInput): Promise<StoredUser> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<UserRow[]>`
      INSERT INTO users (
        id, external_id, callsign, email, avatar_url, created_at, updated_at
      )
      VALUES (
        ${id},
        ${input.externalId},
        ${input.callsign},
        ${input.email ?? null},
        ${input.avatarUrl ?? null},
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToUser(result[0]);
  }

  async function getUser(userId: string): Promise<StoredUser | null> {
    const result = await sql<UserRow[]>`
      SELECT * FROM users WHERE id = ${userId}
    `;

    if (result.length === 0) return null;
    return rowToUser(result[0]);
  }

  async function getUserByExternalId(externalId: string): Promise<StoredUser | null> {
    const result = await sql<UserRow[]>`
      SELECT * FROM users WHERE external_id = ${externalId}
    `;

    if (result.length === 0) return null;
    return rowToUser(result[0]);
  }

  // ---------------------------------------------------------------------------
  // Space Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  async function createSpace(input: CreateSpaceInput): Promise<StoredSpace> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<SpaceRow[]>`
      INSERT INTO spaces (
        id, owner_id, name, created_at, updated_at
      )
      VALUES (
        ${id},
        ${input.ownerId},
        ${input.name ?? null},
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToSpace(result[0]);
  }

  async function getSpace(spaceId: string): Promise<StoredSpace | null> {
    const result = await sql<SpaceRow[]>`
      SELECT * FROM spaces WHERE id = ${spaceId}
    `;

    if (result.length === 0) return null;
    return rowToSpace(result[0]);
  }

  async function getSpacesByOwner(ownerId: string): Promise<StoredSpace[]> {
    const result = await sql<SpaceRow[]>`
      SELECT * FROM spaces
      WHERE owner_id = ${ownerId}
      ORDER BY created_at DESC
    `;

    return result.map(rowToSpace);
  }

  async function listSpacesWithOwners(): Promise<Array<{ space: StoredSpace; owner: StoredUser }>> {
    const result = await sql<(SpaceRow & { user_id: string; user_external_id: string; user_callsign: string; user_email: string | null; user_avatar_url: string | null; user_created_at: Date; user_updated_at: Date })[]>`
      SELECT
        s.id, s.owner_id, s.name, s.created_at, s.updated_at,
        u.id as user_id, u.external_id as user_external_id, u.callsign as user_callsign,
        u.email as user_email, u.avatar_url as user_avatar_url,
        u.created_at as user_created_at, u.updated_at as user_updated_at
      FROM spaces s
      JOIN users u ON s.owner_id = u.id
      ORDER BY s.created_at DESC
    `;

    return result.map(row => ({
      space: {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
      owner: {
        id: row.user_id,
        externalId: row.user_external_id,
        callsign: row.user_callsign,
        email: row.user_email ?? undefined,
        avatarUrl: row.user_avatar_url ?? undefined,
        createdAt: row.user_created_at.toISOString(),
        updatedAt: row.user_updated_at.toISOString(),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Artifact Operations (Phase A)
  // ---------------------------------------------------------------------------

  /**
   * Compute the ltree path for an artifact based on its parent hierarchy.
   */
  async function computeArtifactPath(
    channelId: string,
    slug: string,
    parentSlug?: string
  ): Promise<string> {
    const segment = slugToPathSegment(slug);
    if (!parentSlug) {
      return segment;
    }

    // Get parent's path
    const parent = await sql<{ path: string }[]>`
      SELECT path FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${parentSlug}
    `;

    if (parent.length === 0) {
      throw new Error(`Parent artifact not found: ${parentSlug}`);
    }

    return `${parent[0].path}.${segment}`;
  }

  /**
   * Generate a lexicographic order key for sibling ordering.
   * Uses fractional indexing: between "a" and "b", insert "an".
   */
  async function generateOrderKey(
    channelId: string,
    parentSlug?: string
  ): Promise<string> {
    // Get existing siblings' order keys
    let siblings: { order_key: string }[];
    if (parentSlug) {
      siblings = await sql<{ order_key: string }[]>`
        SELECT order_key FROM artifacts
        WHERE channel_id = ${channelId} AND parent_slug = ${parentSlug}
        ORDER BY order_key DESC
        LIMIT 1
      `;
    } else {
      siblings = await sql<{ order_key: string }[]>`
        SELECT order_key FROM artifacts
        WHERE channel_id = ${channelId} AND parent_slug IS NULL
        ORDER BY order_key DESC
        LIMIT 1
      `;
    }

    if (siblings.length === 0) {
      return 'a'; // First child
    }

    // Append to last key to come after it
    const lastKey = siblings[0].order_key;
    return lastKey + 'a';
  }

  function rowToArtifact(row: ArtifactRow): StoredArtifact {
    // Convert stored secrets to metadata (strip encrypted values)
    let secretsMetadata: Record<string, SecretMetadata> | undefined;
    if (row.secrets) {
      secretsMetadata = {};
      for (const [key, storedSecret] of Object.entries(row.secrets)) {
        secretsMetadata[key] = {
          setAt: storedSecret.setAt,
          expiresAt: storedSecret.expiresAt,
        };
      }
    }

    return {
      id: row.id,
      channelId: row.channel_id,
      slug: row.slug,
      type: row.type as ArtifactType,
      title: row.title ?? undefined,
      tldr: row.tldr ?? undefined,
      content: row.content,
      parentSlug: row.parent_slug ?? undefined,
      path: row.path,
      orderKey: row.order_key,
      status: row.status as ArtifactStatus,
      assignees: row.assignees ?? [],
      labels: row.labels ?? [],
      refs: row.refs ?? [],
      props: row.props ?? undefined,
      secrets: secretsMetadata,
      contentType: row.content_type ?? undefined,
      fileSize: row.file_size ?? undefined,
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedBy: row.updated_by ?? undefined,
      updatedAt: row.updated_at?.toISOString(),
    };
  }

  function rowToArtifactSummary(row: ArtifactRow): ArtifactSummary {
    return {
      slug: row.slug,
      type: row.type as ArtifactType,
      title: row.title ?? undefined,
      tldr: row.tldr ?? undefined,
      status: row.status as ArtifactStatus,
      path: row.path,
      orderKey: row.order_key,
      assignees: row.assignees ?? [],
      parentSlug: row.parent_slug ?? undefined,
      channelId: row.channel_id,
      props: row.props ?? undefined,
    };
  }

  async function createArtifact(
    channelId: string,
    input: CreateArtifactInput
  ): Promise<StoredArtifact> {
    const id = ulid();
    const now = new Date();
    const path = await computeArtifactPath(channelId, input.slug, input.parentSlug);
    const orderKey = await generateOrderKey(channelId, input.parentSlug);
    const refs = extractRefs(input.content);
    const status = input.status ?? getDefaultArtifactStatus(input.type);

    try {
      const result = await sql<ArtifactRow[]>`
        INSERT INTO artifacts (
          id, channel_id, slug, type, title, tldr, content, parent_slug, path,
          order_key, status, assignees, labels, refs, props,
          content_type, file_size,
          version, created_by, created_at
        )
        VALUES (
          ${id},
          ${channelId},
          ${input.slug},
          ${input.type},
          ${input.title ?? null},
          ${input.tldr ?? null},
          ${input.content},
          ${input.parentSlug ?? null},
          ${path},
          ${orderKey},
          ${status},
          ${sql.array(input.assignees ?? [])},
          ${sql.array(input.labels ?? [])},
          ${sql.array(refs)},
          ${input.props ? sql.json(input.props as JSONValue) : null},
          ${input.contentType ?? null},
          ${input.fileSize ?? null},
          1,
          ${input.createdBy},
          ${now}
        )
        RETURNING *
      `;

      return rowToArtifact(result[0]);
    } catch (err: unknown) {
      const message = (err as Error).message ?? '';
      if (message.includes('unique') || message.includes('duplicate')) {
        throw new Error(`Artifact already exists: ${input.slug}`);
      }
      throw err;
    }
  }

  async function getArtifact(
    channelId: string,
    slug: string
  ): Promise<StoredArtifact | null> {
    const result = await sql<ArtifactRow[]>`
      SELECT * FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) return null;
    return rowToArtifact(result[0]);
  }

  async function updateArtifactWithCAS(
    channelId: string,
    slug: string,
    changes: ArtifactCASChange[],
    updatedBy: string
  ): Promise<ArtifactCASResult> {
    // Get current artifact state
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Normalize values for comparison (treat null and undefined as equivalent)
    const normalize = (val: unknown): unknown =>
      val === undefined || val === null ? null : val;

    // Verify all CAS conditions
    for (const change of changes) {
      const currentValue = normalize(artifact[change.field as keyof StoredArtifact]);
      const expectedValue = normalize(change.oldValue);
      const currentStr = JSON.stringify(currentValue);
      const expectedStr = JSON.stringify(expectedValue);

      if (currentStr !== expectedStr) {
        return {
          success: false,
          conflict: {
            field: change.field,
            expected: change.oldValue,
            actual: artifact[change.field as keyof StoredArtifact],
          },
        };
      }
    }

    // Build update object
    const now = new Date();
    const updateObj: Record<string, unknown> = {
      updated_by: updatedBy,
      updated_at: now,
    };

    for (const change of changes) {
      switch (change.field) {
        case 'title':
          updateObj.title = change.newValue ?? null;
          break;
        case 'tldr':
          updateObj.tldr = change.newValue ?? null;
          break;
        case 'status':
          updateObj.status = change.newValue;
          break;
        case 'parentSlug': {
          const newParentSlug = change.newValue as string | null | undefined;
          updateObj.parent_slug = newParentSlug ?? null;
          // Recompute path when parent changes
          const newPath = await computeArtifactPath(channelId, slug, newParentSlug ?? undefined);
          updateObj.path = newPath;
          break;
        }
        case 'assignees':
          updateObj.assignees = change.newValue ?? [];
          break;
        case 'labels':
          updateObj.labels = change.newValue ?? [];
          break;
        case 'props':
          updateObj.props = change.newValue ? JSON.stringify(change.newValue) : null;
          break;
        case 'orderKey':
          updateObj.order_key = change.newValue ?? null;
          break;
      }
    }

    // Apply the updates
    const title = 'title' in updateObj ? (updateObj.title as string | null) : (artifact.title ?? null);
    const tldr = 'tldr' in updateObj ? (updateObj.tldr as string | null) : (artifact.tldr ?? null);
    const status = 'status' in updateObj ? (updateObj.status as string) : artifact.status;
    const parentSlug = 'parent_slug' in updateObj ? (updateObj.parent_slug as string | null) : (artifact.parentSlug ?? null);
    const path = 'path' in updateObj ? (updateObj.path as string) : artifact.path;
    const assignees = 'assignees' in updateObj ? (updateObj.assignees as string[]) : artifact.assignees;
    const labels = 'labels' in updateObj ? (updateObj.labels as string[]) : artifact.labels;
    const propsValue = 'props' in updateObj ? (updateObj.props as Record<string, unknown> | null) : (artifact.props ?? null);
    const orderKey = 'order_key' in updateObj ? (updateObj.order_key as string | null) : (artifact.orderKey ?? null);

    // Increment version
    await sql`
      UPDATE artifacts
      SET
        title = ${title},
        tldr = ${tldr},
        status = ${status},
        parent_slug = ${parentSlug},
        path = ${path},
        assignees = ${sql.array(assignees)},
        labels = ${sql.array(labels)},
        props = ${propsValue ? sql.json(propsValue as JSONValue) : null},
        order_key = ${orderKey},
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return { success: true, artifact: updated! };
  }

  async function editArtifact(
    channelId: string,
    slug: string,
    edit: ArtifactEditInput
  ): Promise<StoredArtifact> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Check that oldString matches exactly once
    const matches = artifact.content.split(edit.oldString).length - 1;
    if (matches === 0) {
      throw new Error(`String not found in artifact content`);
    }
    if (matches > 1) {
      throw new Error(`String matches ${matches} times, must be unique`);
    }

    // Perform the replacement
    const newContent = artifact.content.replace(edit.oldString, edit.newString);
    const newRefs = extractRefs(newContent);
    const now = new Date();

    await sql`
      UPDATE artifacts
      SET
        content = ${newContent},
        refs = ${sql.array(newRefs)},
        version = version + 1,
        updated_by = ${edit.updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return updated!;
  }

  async function archiveArtifact(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<StoredArtifact> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    await sql`
      UPDATE artifacts
      SET
        status = 'archived',
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return updated!;
  }

  async function archiveArtifactRecursive(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<RecursiveArchiveResult> {
    // First, get the artifact to find its path
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    // Find all artifacts that are descendants (path starts with this artifact's path)
    // Using ltree path for efficient hierarchical query
    // Also include the artifact itself
    const toArchive = await sql<{ slug: string; status: string }[]>`
      SELECT slug, status
      FROM artifacts
      WHERE channel_id = ${channelId}
        AND status != 'archived'
        AND (slug = ${slug} OR path <@ ${artifact.path}::ltree)
      ORDER BY path
    `;

    if (toArchive.length === 0) {
      return { archived: [], count: 0 };
    }

    // Store previous statuses for undo
    const archivedItems: ArchivedItem[] = toArchive.map(row => ({
      slug: row.slug,
      previousStatus: row.status as ArtifactStatus,
    }));

    // Archive all in one UPDATE using the same path query
    await sql`
      UPDATE artifacts
      SET
        status = 'archived',
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId}
        AND status != 'archived'
        AND (slug = ${slug} OR path <@ ${artifact.path}::ltree)
    `;

    return {
      archived: archivedItems,
      count: archivedItems.length,
    };
  }

  async function listArtifacts(
    channelId: string,
    params?: ListArtifactsParams
  ): Promise<ArtifactSummary[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    // Build dynamic query based on filters
    // Note: Using raw SQL building here since postgres.js doesn't easily support
    // complex conditional WHERE clauses
    const conditions: string[] = ['channel_id = $1'];
    const values: unknown[] = [channelId];
    let paramIndex = 2;

    if (params?.type) {
      conditions.push(`type = $${paramIndex++}`);
      values.push(params.type);
    }

    if (params?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(params.status);
    } else {
      conditions.push(`status != 'archived'`);
    }

    if (params?.assignee) {
      conditions.push(`$${paramIndex++} = ANY(assignees)`);
      values.push(params.assignee);
    }

    if (params?.parentSlug === 'root') {
      conditions.push(`parent_slug IS NULL`);
    } else if (params?.parentSlug) {
      conditions.push(`parent_slug = $${paramIndex++}`);
      values.push(params.parentSlug);
    }

    if (params?.search) {
      // FTS search using tsvector
      conditions.push(`search_vector @@ plainto_tsquery('english', $${paramIndex++})`);
      values.push(params.search);
    }

    if (params?.regex) {
      conditions.push(`(slug ~* $${paramIndex} OR title ~* $${paramIndex} OR tldr ~* $${paramIndex} OR content ~* $${paramIndex++})`);
      values.push(params.regex);
    }

    values.push(limit, offset);

    const query = `
      SELECT slug, type, title, tldr, status, path, order_key, assignees, parent_slug, channel_id, props
      FROM artifacts
      WHERE ${conditions.join(' AND ')}
      ORDER BY path ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const result = await sql.unsafe(query, values as (string | number | boolean | null)[]) as ArtifactRow[];
    return result.map(rowToArtifactSummary);
  }

  async function globArtifacts(
    channelId: string,
    pattern: string
  ): Promise<ArtifactTreeNode[]> {
    // Convert glob pattern to ltree query
    let ltreeQuery: string;
    let isRootOnly = false;

    if (pattern === '/**') {
      // All artifacts
      ltreeQuery = '*';
    } else if (pattern === '/*') {
      // Root level only
      isRootOnly = true;
      ltreeQuery = '*';
    } else if (pattern.endsWith('/**')) {
      // Subtree under a path
      const base = pattern.slice(1, -3); // Remove leading / and trailing /**
      const ltreePath = base.split('/').map(slugToPathSegment).join('.');
      ltreeQuery = `${ltreePath}.*`;
    } else {
      // Specific pattern
      const cleanPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
      ltreeQuery = cleanPattern.split('/').map(s => s.replace(/\*/g, '%')).join('.');
    }

    let result: (ArtifactRow & { parent_slug: string | null })[];

    if (isRootOnly) {
      result = await sql<(ArtifactRow & { parent_slug: string | null })[]>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND parent_slug IS NULL
          AND status != 'archived'
        ORDER BY order_key ASC
      `;
    } else if (ltreeQuery === '*') {
      result = await sql<(ArtifactRow & { parent_slug: string | null })[]>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND status != 'archived'
        ORDER BY path ASC, order_key ASC
      `;
    } else {
      result = await sql<(ArtifactRow & { parent_slug: string | null })[]>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND path ~ ${ltreeQuery}::lquery
          AND status != 'archived'
        ORDER BY path ASC, order_key ASC
      `;
    }

    // Build tree structure
    const nodeMap = new Map<string, ArtifactTreeNode>();
    const rootNodes: ArtifactTreeNode[] = [];

    for (const row of result) {
      const node: ArtifactTreeNode = {
        slug: row.slug,
        type: row.type as ArtifactType,
        title: row.title ?? undefined,
        status: row.status as ArtifactStatus,
        path: row.path,
        orderKey: row.order_key,
        assignees: row.assignees ?? [],
        children: [],
      };
      nodeMap.set(row.slug, node);
    }

    for (const row of result) {
      const node = nodeMap.get(row.slug)!;
      if (row.parent_slug && nodeMap.has(row.parent_slug)) {
        nodeMap.get(row.parent_slug)!.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Sort all children arrays by orderKey
    // Use simple string comparison (not localeCompare) because fractional-indexing
    // generates keys designed for ASCII/Unicode code point ordering
    const sortByOrderKey = (nodes: ArtifactTreeNode[]) => {
      nodes.sort((a, b) => {
        const aKey = a.orderKey || '';
        const bKey = b.orderKey || '';
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
      for (const node of nodes) {
        if (node.children.length > 0) {
          sortByOrderKey(node.children);
        }
      }
    };

    sortByOrderKey(rootNodes);

    return rootNodes;
  }

  async function checkpointArtifact(
    channelId: string,
    slug: string,
    input: CreateArtifactVersionInput
  ): Promise<ArtifactVersion> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    await sql`
      INSERT INTO artifact_versions (
        channel_id, slug, version_name, version_message,
        version_created_at, version_created_by, tldr, content
      )
      VALUES (
        ${channelId},
        ${slug},
        ${input.versionName},
        ${input.versionMessage ?? null},
        ${now},
        ${input.createdBy},
        ${artifact.tldr ?? ''},
        ${artifact.content}
      )
    `;

    return {
      slug,
      channelId,
      versionName: input.versionName,
      versionMessage: input.versionMessage,
      tldr: artifact.tldr ?? '',
      content: artifact.content,
      versionCreatedBy: input.createdBy,
      versionCreatedAt: now.toISOString(),
    };
  }

  async function getArtifactVersion(
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null> {
    const result = await sql<ArtifactVersionRow[]>`
      SELECT slug, channel_id, version_name, version_message,
             version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE channel_id = ${channelId}
        AND slug = ${slug}
        AND version_name = ${versionName}
    `;

    if (result.length === 0) return null;

    const row = result[0];
    return {
      slug: row.slug,
      channelId: row.channel_id,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      tldr: row.tldr,
      content: row.content,
      versionCreatedBy: row.version_created_by,
      versionCreatedAt: row.version_created_at.toISOString(),
    };
  }

  async function listArtifactVersions(
    channelId: string,
    slug: string
  ): Promise<ArtifactVersion[]> {
    const result = await sql<ArtifactVersionRow[]>`
      SELECT slug, channel_id, version_name, version_message,
             version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE channel_id = ${channelId} AND slug = ${slug}
      ORDER BY version_created_at DESC
    `;

    return result.map(row => ({
      slug: row.slug,
      channelId: row.channel_id,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      tldr: row.tldr,
      content: row.content,
      versionCreatedBy: row.version_created_by,
      versionCreatedAt: row.version_created_at.toISOString(),
    }));
  }

  /**
   * Generate a unified diff between two strings.
   * Simple line-by-line implementation without external dependencies.
   */
  function generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    oldLabel: string,
    newLabel: string
  ): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Simple LCS-based diff algorithm
    const lcs = computeLCS(oldLines, newLines);

    const diff: string[] = [];
    diff.push(`--- ${oldLabel}`);
    diff.push(`+++ ${newLabel}`);

    let oldIdx = 0;
    let newIdx = 0;
    let hunkOldStart = 0;
    let hunkNewStart = 0;
    let hunkLines: string[] = [];

    function flushHunk() {
      if (hunkLines.length > 0) {
        const hunkOldCount = hunkLines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
        const hunkNewCount = hunkLines.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
        diff.push(`@@ -${hunkOldStart + 1},${hunkOldCount} +${hunkNewStart + 1},${hunkNewCount} @@`);
        diff.push(...hunkLines);
        hunkLines = [];
      }
    }

    for (const match of lcs) {
      // Output removed lines
      while (oldIdx < match.oldIdx) {
        if (hunkLines.length === 0) {
          hunkOldStart = oldIdx;
          hunkNewStart = newIdx;
        }
        hunkLines.push(`-${oldLines[oldIdx]}`);
        oldIdx++;
      }
      // Output added lines
      while (newIdx < match.newIdx) {
        if (hunkLines.length === 0) {
          hunkOldStart = oldIdx;
          hunkNewStart = newIdx;
        }
        hunkLines.push(`+${newLines[newIdx]}`);
        newIdx++;
      }
      // Output context (matching line)
      if (hunkLines.length > 0) {
        hunkLines.push(` ${oldLines[oldIdx]}`);
      }
      oldIdx++;
      newIdx++;

      // Flush hunk if we have enough trailing context
      const lastFewAreContext = hunkLines.slice(-3).every(l => l.startsWith(' '));
      if (lastFewAreContext && hunkLines.length > 6) {
        // Remove trailing context, flush, reset
        const trailing = hunkLines.splice(-3);
        flushHunk();
        hunkOldStart = oldIdx - 3;
        hunkNewStart = newIdx - 3;
        hunkLines = trailing;
      }
    }

    // Handle remaining lines after last match
    while (oldIdx < oldLines.length) {
      if (hunkLines.length === 0) {
        hunkOldStart = oldIdx;
        hunkNewStart = newIdx;
      }
      hunkLines.push(`-${oldLines[oldIdx]}`);
      oldIdx++;
    }
    while (newIdx < newLines.length) {
      if (hunkLines.length === 0) {
        hunkOldStart = oldIdx;
        hunkNewStart = newIdx;
      }
      hunkLines.push(`+${newLines[newIdx]}`);
      newIdx++;
    }

    flushHunk();

    return diff.join('\n');
  }

  /**
   * Compute Longest Common Subsequence for diff algorithm.
   * Returns array of matching indices.
   */
  function computeLCS(
    oldLines: string[],
    newLines: string[]
  ): Array<{ oldIdx: number; newIdx: number }> {
    const m = oldLines.length;
    const n = newLines.length;

    // Build LCS table
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find matches
    const matches: Array<{ oldIdx: number; newIdx: number }> = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return matches;
  }

  async function diffArtifactVersions(
    channelId: string,
    slug: string,
    fromVersion: string,
    toVersion?: string
  ): Promise<string> {
    // Get the "from" version
    const fromVer = await getArtifactVersion(channelId, slug, fromVersion);
    if (!fromVer) {
      throw new Error(`Version '${fromVersion}' not found for artifact '${slug}'`);
    }

    let toContent: string;
    let toLabel: string;

    if (toVersion) {
      // Get the "to" version
      const toVer = await getArtifactVersion(channelId, slug, toVersion);
      if (!toVer) {
        throw new Error(`Version '${toVersion}' not found for artifact '${slug}'`);
      }
      toContent = toVer.content;
      toLabel = `${slug}@${toVersion}`;
    } else {
      // Compare against current content
      const artifact = await getArtifact(channelId, slug);
      if (!artifact) {
        throw new Error(`Artifact not found: ${slug}`);
      }
      toContent = artifact.content;
      toLabel = `${slug} (current)`;
    }

    const fromLabel = `${slug}@${fromVersion}`;

    return generateUnifiedDiff(fromVer.content, toContent, fromLabel, toLabel);
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

    // ---------------------------------------------------------------------------
    // Users Table (Spaces & Auth)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(26) PRIMARY KEY,
        external_id VARCHAR(255) NOT NULL,
        callsign VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        avatar_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id
      ON users(external_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_users_callsign
      ON users(callsign)
    `;

    // ---------------------------------------------------------------------------
    // Spaces Table (Spaces & Auth)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS spaces (
        id VARCHAR(26) PRIMARY KEY,
        owner_id VARCHAR(26) NOT NULL REFERENCES users(id),
        name VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_spaces_owner
      ON spaces(owner_id)
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

    // Add callback_url and readmark columns to roster if they don't exist
    // (These may be added in migrations for existing databases)
    await sql`
      DO $$ BEGIN
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS callback_url TEXT;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS readmark VARCHAR(26);
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // ---------------------------------------------------------------------------
    // Artifacts Tables (Phase A)
    // ---------------------------------------------------------------------------

    // Enable ltree extension for hierarchical paths
    await sql`CREATE EXTENSION IF NOT EXISTS ltree`;

    // Create artifacts table
    await sql`
      CREATE TABLE IF NOT EXISTS artifacts (
        id VARCHAR(26) PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        title TEXT,
        tldr TEXT,
        content TEXT NOT NULL,
        parent_slug VARCHAR(255),
        path LTREE NOT NULL,
        order_key VARCHAR(255) NOT NULL DEFAULT 'a',
        status VARCHAR(50) NOT NULL DEFAULT 'draft',
        assignees TEXT[] NOT NULL DEFAULT '{}',
        labels TEXT[] NOT NULL DEFAULT '{}',
        refs TEXT[] NOT NULL DEFAULT '{}',
        props JSONB,
        secrets JSONB,
        version INTEGER NOT NULL DEFAULT 1,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by VARCHAR(255),
        updated_at TIMESTAMPTZ,
        -- Generated tsvector column for FTS
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(tldr, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(content, '')), 'C')
        ) STORED,
        CONSTRAINT artifacts_channel_slug_unique UNIQUE(channel_id, slug)
      )
    `;

    // Create artifacts indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_channel
      ON artifacts(channel_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_type
      ON artifacts(channel_id, type)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_status
      ON artifacts(channel_id, status)
    `;

    // GiST index for ltree path queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_path
      ON artifacts USING GIST(path)
    `;

    // GIN index for array membership queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_assignees
      ON artifacts USING GIN(assignees)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_labels
      ON artifacts USING GIN(labels)
    `;

    // GIN index for full-text search
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_search
      ON artifacts USING GIN(search_vector)
    `;

    // Create artifact_versions table for checkpoints
    await sql`
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        version_name VARCHAR(255) NOT NULL,
        version_message TEXT,
        version_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version_created_by VARCHAR(255) NOT NULL,
        tldr TEXT NOT NULL,
        content TEXT NOT NULL,
        CONSTRAINT artifact_versions_unique UNIQUE(channel_id, slug, version_name)
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
      ON artifact_versions(channel_id, slug)
    `;

    // Add content_type, file_size columns if they don't exist (migration for existing databases)
    await sql`
      DO $$ BEGIN
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_type VARCHAR(255);
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_size BIGINT;
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // Add secrets column if it doesn't exist (migration for App Integrations)
    await sql`
      DO $$ BEGIN
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS secrets JSONB;
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // ---------------------------------------------------------------------------
    // Local Agent Servers Table (Stage 3)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS local_agent_servers (
        server_id VARCHAR(255) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        user_id VARCHAR(26) NOT NULL,
        secret VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `;

    // Index for looking up servers by secret (auth flow)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_agent_servers_secret
      ON local_agent_servers(secret) WHERE revoked_at IS NULL
    `;

    // Index for looking up servers by user (UI listing)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_local_agent_servers_user
      ON local_agent_servers(user_id) WHERE revoked_at IS NULL
    `;

    // Index for space-scoped queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_local_agent_servers_space
      ON local_agent_servers(space_id)
    `;
  }

  async function close(): Promise<void> {
    await sql.end();
  }

  // ---------------------------------------------------------------------------
  // Secrets Operations (App Integrations)
  // ---------------------------------------------------------------------------

  /**
   * Get the SECRET_KEY from environment.
   * Required for encryption/decryption operations.
   * In production, SECRET_KEY must be explicitly set.
   * In development, falls back to a default (DO NOT use in production).
   */
  function getSecretKey(): string {
    const key = process.env.SECRET_KEY;
    if (!key) {
      // Fail hard in production — no fallback allowed
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SECRET_KEY environment variable is required in production');
      }
      // Dev fallback — never use in production
      console.warn('[Storage] WARNING: Using default SECRET_KEY — DO NOT use in production');
      return 'cast-dev-secret-key-min-32-characters!!';
    }
    if (key.length < 32) {
      throw new Error('SECRET_KEY must be at least 32 characters');
    }
    return key;
  }

  /**
   * Derive an encryption key from spaceId and server secret.
   * Each space has a unique derived key for isolation.
   */
  function deriveKey(spaceId: string): Buffer {
    const serverKey = getSecretKey();
    return crypto.createHash('sha256')
      .update(`${spaceId}:${serverKey}`)
      .digest();
  }

  /**
   * Encrypt a plaintext value using AES-256-GCM.
   */
  function encrypt(plaintext: string, spaceId: string): { encrypted: string; iv: string; tag: string } {
    const key = deriveKey(spaceId);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /**
   * Decrypt an encrypted value using AES-256-GCM.
   */
  function decrypt(encryptedData: { encrypted: string; iv: string; tag: string }, spaceId: string): string {
    const key = deriveKey(spaceId);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(encryptedData.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));
    return decipher.update(Buffer.from(encryptedData.encrypted, 'base64')) + decipher.final('utf8');
  }

  async function setSecret(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string,
    input: SetSecretInput
  ): Promise<void> {
    // Get current artifact to merge secrets
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Encrypt the value
    const encrypted = encrypt(input.value, spaceId);
    const now = new Date().toISOString();

    // Build the stored secret
    const storedSecret: StoredSecret = {
      setAt: now,
      expiresAt: input.expiresAt,
      encrypted: encrypted.encrypted,
      iv: encrypted.iv,
      tag: encrypted.tag,
    };

    // Get current secrets (need to fetch raw from DB to preserve encrypted values)
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }[]>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const secrets = currentSecrets[0]?.secrets ?? {};
    secrets[key] = storedSecret;

    // Update the artifact with new secrets
    await sql`
      UPDATE artifacts
      SET secrets = ${sql.json(secrets as unknown as JSONValue)},
          version = version + 1,
          updated_at = NOW()
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;
  }

  async function deleteSecret(
    channelId: string,
    slug: string,
    key: string
  ): Promise<void> {
    // Get current secrets
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }[]>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (currentSecrets.length === 0) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const secrets = currentSecrets[0]?.secrets ?? {};
    if (!(key in secrets)) {
      return; // Secret doesn't exist, nothing to delete
    }

    delete secrets[key];

    // Update with null if no secrets remain, otherwise update with remaining secrets
    const secretsValue = Object.keys(secrets).length > 0 ? secrets : null;

    await sql`
      UPDATE artifacts
      SET secrets = ${secretsValue ? sql.json(secretsValue as unknown as JSONValue) : null},
          version = version + 1,
          updated_at = NOW()
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;
  }

  async function getSecretValue(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string
  ): Promise<string | null> {
    // Get the raw secrets from DB
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }[]>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];

    // Decrypt and return
    return decrypt(
      {
        encrypted: storedSecret.encrypted,
        iv: storedSecret.iv,
        tag: storedSecret.tag,
      },
      spaceId
    );
  }

  async function getSecretMetadata(
    channelId: string,
    slug: string,
    key: string
  ): Promise<SecretMetadata | null> {
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }[]>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];
    return {
      setAt: storedSecret.setAt,
      expiresAt: storedSecret.expiresAt,
    };
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

  function rowToLocalAgentServer(row: LocalAgentServerRow): StoredLocalAgentServer {
    return {
      serverId: row.server_id,
      spaceId: row.space_id,
      userId: row.user_id,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Local Agent Server Operations (Stage 3)
  // ---------------------------------------------------------------------------

  async function saveLocalAgentServer(
    input: CreateLocalAgentServerInput
  ): Promise<StoredLocalAgentServer> {
    const now = new Date();

    const result = await sql<LocalAgentServerRow[]>`
      INSERT INTO local_agent_servers (
        server_id, space_id, user_id, secret, created_at
      )
      VALUES (
        ${input.serverId},
        ${input.spaceId},
        ${input.userId},
        ${input.secret},
        ${now}
      )
      RETURNING *
    `;

    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServer(
    serverId: string
  ): Promise<StoredLocalAgentServer | null> {
    const result = await sql<LocalAgentServerRow[]>`
      SELECT * FROM local_agent_servers
      WHERE server_id = ${serverId}
    `;

    if (result.length === 0) return null;
    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServerBySecret(
    secret: string
  ): Promise<StoredLocalAgentServer | null> {
    const result = await sql<LocalAgentServerRow[]>`
      SELECT * FROM local_agent_servers
      WHERE secret = ${secret} AND revoked_at IS NULL
    `;

    if (result.length === 0) return null;
    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServersByUser(
    userId: string
  ): Promise<StoredLocalAgentServer[]> {
    const result = await sql<LocalAgentServerRow[]>`
      SELECT * FROM local_agent_servers
      WHERE user_id = ${userId} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;

    return result.map(rowToLocalAgentServer);
  }

  async function revokeLocalAgentServer(serverId: string): Promise<boolean> {
    const now = new Date();

    const result = await sql`
      UPDATE local_agent_servers
      SET revoked_at = ${now}
      WHERE server_id = ${serverId} AND revoked_at IS NULL
      RETURNING server_id
    `;

    return result.length > 0;
  }

  return {
    // Message operations
    saveMessage,
    getMessage,
    getMessages,
    updateMessage,
    deleteMessage,
    // User operations (Spaces & Auth)
    createUser,
    getUser,
    getUserByExternalId,
    // Space operations (Spaces & Auth)
    createSpace,
    getSpace,
    getSpacesByOwner,
    listSpacesWithOwners,
    // Channel operations
    createChannel,
    getChannel,
    getChannelById,
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
    // Artifact operations (Phase A)
    createArtifact,
    getArtifact,
    updateArtifactWithCAS,
    editArtifact,
    archiveArtifact,
    archiveArtifactRecursive,
    listArtifacts,
    globArtifacts,
    checkpointArtifact,
    getArtifactVersion,
    listArtifactVersions,
    diffArtifactVersions,
    // Secrets operations (App Integrations)
    setSecret,
    deleteSecret,
    getSecretValue,
    getSecretMetadata,
    // Local Agent Server operations (Stage 3)
    saveLocalAgentServer,
    getLocalAgentServer,
    getLocalAgentServerBySecret,
    getLocalAgentServersByUser,
    revokeLocalAgentServer,
    // Lifecycle
    initialize,
    close,
  };
}
