/**
 * DynamoDB Storage Adapter
 *
 * AWS production storage using single-table design.
 * NOTE: Multi-tenancy (spaceId) support is STUBBED - will be implemented later.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
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
  ArtifactStatus,
  CreateArtifactInput,
  UpdateArtifactInput,
  ListArtifactsParams,
  CASChange,
  CASResult,
} from '../interface.js';

// =============================================================================
// DynamoDB Storage Implementation
// =============================================================================

export interface DynamoDbStorageOptions {
  /** AWS region */
  region: string;
  /** Table name */
  tableName: string;
  /** Optional endpoint (for DynamoDB Local) */
  endpoint?: string;
}

/**
 * Single-table design keys:
 *
 * Spaces:     PK=SPACE#{id}           SK=META
 * Channels:   PK=SPACE#{spaceId}      SK=CHANNEL#{id}
 * Roster:     PK=CHANNEL#{spaceId}#{channelId}  SK=ROSTER#{participantId}
 * Messages:   PK=CHANNEL#{spaceId}#{channelId}  SK=MSG#{messageId}
 * Artifacts:  PK=CHANNEL#{spaceId}#{channelId}  SK=ARTIFACT#{slug}
 * ArtifactVersions: PK=CHANNEL#{spaceId}#{channelId}  SK=ARTIFACT#{slug}#VER#{versionName}
 *
 * GSI1 (for listing all channels in a space, artifact type filtering):
 * Channels:   GSI1PK=SPACE#{spaceId}#CHANNELS  GSI1SK={createdAt}
 * Artifacts:  GSI1PK=CHANNEL#{spaceId}#{channelId}#ARTIFACTS  GSI1SK=TYPE#{type}#{slug}
 *
 * GSI2 (for finding spaces by owner, artifact status filtering):
 * Spaces:     GSI2PK=OWNER#{ownerId}  GSI2SK=SPACE
 * Artifacts:  GSI2PK=CHANNEL#{spaceId}#{channelId}#ARTIFACTS  GSI2SK=STATUS#{status}#{slug}
 */

import { ulid } from 'ulid';

export function createDynamoDbStorage(options: DynamoDbStorageOptions): Storage {
  const client = new DynamoDBClient({
    region: options.region,
    endpoint: options.endpoint,
  });

  const docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  const { tableName } = options;

  // ---------------------------------------------------------------------------
  // Space Operations
  // ---------------------------------------------------------------------------

  async function createSpace(params: CreateSpaceParams): Promise<Space> {
    const now = new Date().toISOString();
    const spaceId = params.id || ulid();

    const space: Space = {
      id: spaceId,
      ownerId: params.ownerId,
      name: params.name,
      createdAt: now,
    };

    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SPACE#${spaceId}`,
        SK: 'META',
        GSI2PK: `OWNER#${params.ownerId}`,
        GSI2SK: 'SPACE',
        ...space,
      },
      ConditionExpression: 'attribute_not_exists(PK)', // Prevent overwrite
    }));

    return space;
  }

  async function getSpace(spaceId: string): Promise<Space | null> {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: {
        PK: `SPACE#${spaceId}`,
        SK: 'META',
      },
    }));

    if (!result.Item) return null;

    return {
      id: result.Item.id as string,
      ownerId: result.Item.ownerId as string,
      name: result.Item.name as string | undefined,
      createdAt: result.Item.createdAt as string,
    };
  }

  async function getSpaceByOwnerId(ownerId: string): Promise<Space | null> {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `OWNER#${ownerId}`,
        ':sk': 'SPACE',
      },
      Limit: 1,
    }));

    if (!result.Items || result.Items.length === 0) return null;

    const item = result.Items[0];
    return {
      id: item.id as string,
      ownerId: item.ownerId as string,
      name: item.name as string | undefined,
      createdAt: item.createdAt as string,
    };
  }

  async function getOrCreateSpace(ownerId: string, name?: string): Promise<Space> {
    // Check if space already exists for this owner
    const existing = await getSpaceByOwnerId(ownerId);
    if (existing) {
      return existing;
    }

    // Create new space
    return createSpace({ ownerId, name });
  }

  async function listSpaces(): Promise<Space[]> {
    // Note: This scans all spaces which is inefficient at scale.
    // For production with many users, consider pagination or limiting.
    // Acceptable for MVP since admin-only usage.
    // QueryCommand doesn't support begins_with on partition key,
    // so we use Scan instead for listing all spaces.
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const result = await docClient.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
      ExpressionAttributeValues: {
        ':prefix': 'SPACE#',
        ':sk': 'META',
      },
    }));

    return (result.Items || []).map(item => ({
      id: item.id as string,
      ownerId: item.ownerId as string,
      name: item.name as string | undefined,
      createdAt: item.createdAt as string,
    }));
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
      createdAt: now,
      status: 'active',
      // Include optional fields if provided
      ...(params.leader && { leader: params.leader }),
      ...(params.tagline && { tagline: params.tagline }),
      ...(params.mission && { mission: params.mission }),
      ...(params.focusSlug && { focusSlug: params.focusSlug }),
    };

    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SPACE#${spaceId}`,
        SK: `CHANNEL#${channel.id}`,
        GSI1PK: `SPACE#${spaceId}#CHANNELS`,
        GSI1SK: channel.createdAt,
        ...channel,
      },
    }));

    return channel;
  }

  async function getChannel(spaceId: string, channelId: string): Promise<Channel | null> {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: {
        PK: `SPACE#${spaceId}`,
        SK: `CHANNEL#${channelId}`,
      },
    }));

    if (!result.Item) return null;

    // Get roster IDs
    const rosterResult = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CHANNEL#${spaceId}#${channelId}`,
        ':sk': 'ROSTER#',
      },
      ProjectionExpression: 'id',
    }));

    const roster = (rosterResult.Items || []).map(item => item.id as string);

    return {
      id: result.Item.id as string,
      spaceId: result.Item.spaceId as string,
      name: result.Item.name as string,
      description: result.Item.description as string | undefined,
      roster,
      createdAt: result.Item.createdAt as string,
      status: result.Item.status as ChannelStatus,
      leader: result.Item.leader as string | undefined,
      focusSlug: result.Item.focusSlug as string | undefined,
      tagline: result.Item.tagline as string | undefined,
      mission: result.Item.mission as string | undefined,
    };
  }

  async function getChannelByName(spaceId: string, name: string): Promise<Channel | null> {
    // Query all channels in the space and filter by name
    // Note: For production, consider adding a GSI on (spaceId, name) for direct lookup
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      FilterExpression: '#name = :name',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':pk': `SPACE#${spaceId}#CHANNELS`,
        ':name': name,
      },
      Limit: 1,
    }));

    if (!result.Items || result.Items.length === 0) return null;

    const item = result.Items[0];
    const channelId = item.id as string;

    // Get roster IDs
    const rosterResult = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CHANNEL#${spaceId}#${channelId}`,
        ':sk': 'ROSTER#',
      },
      ProjectionExpression: 'id',
    }));

    const roster = (rosterResult.Items || []).map(r => r.id as string);

    return {
      id: channelId,
      spaceId: item.spaceId as string,
      name: item.name as string,
      description: item.description as string | undefined,
      roster,
      createdAt: item.createdAt as string,
      status: item.status as ChannelStatus,
      leader: item.leader as string | undefined,
      focusSlug: item.focusSlug as string | undefined,
      tagline: item.tagline as string | undefined,
      mission: item.mission as string | undefined,
    };
  }

  async function listChannels(spaceId: string, params?: ListChannelsParams): Promise<Channel[]> {
    const includeArchived = params?.includeArchived ?? false;
    const limit = params?.limit ?? 100;

    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      FilterExpression: includeArchived ? undefined : '#status <> :archived',
      ExpressionAttributeNames: includeArchived ? undefined : { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': `SPACE#${spaceId}#CHANNELS`,
        ...(includeArchived ? {} : { ':archived': 'archived' }),
      },
      ScanIndexForward: false, // Newest first
      Limit: limit,
    }));

    return (result.Items || []).map(item => ({
      id: item.id as string,
      spaceId: item.spaceId as string,
      name: item.name as string,
      description: item.description as string | undefined,
      roster: [], // Would need separate query per channel for roster
      createdAt: item.createdAt as string,
      status: item.status as ChannelStatus,
      leader: item.leader as string | undefined,
      focusSlug: item.focusSlug as string | undefined,
      tagline: item.tagline as string | undefined,
      mission: item.mission as string | undefined,
    }));
  }

  async function updateChannelStatus(spaceId: string, channelId: string, status: ChannelStatus): Promise<void> {
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: `SPACE#${spaceId}`,
        SK: `CHANNEL#${channelId}`,
      },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }));
  }

  // ---------------------------------------------------------------------------
  // Roster Operations
  // ---------------------------------------------------------------------------

  async function addToRoster(spaceId: string, channelId: string, entry: RosterEntry): Promise<void> {
    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `CHANNEL#${spaceId}#${channelId}`,
        SK: `ROSTER#${entry.id}`,
        ...entry,
      },
    }));
  }

  async function removeFromRoster(spaceId: string, channelId: string, participantId: string): Promise<void> {
    await docClient.send(new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: `CHANNEL#${spaceId}#${channelId}`,
        SK: `ROSTER#${participantId}`,
      },
    }));
  }

  async function getRoster(spaceId: string, channelId: string): Promise<RosterEntry[]> {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CHANNEL#${spaceId}#${channelId}`,
        ':sk': 'ROSTER#',
      },
    }));

    return (result.Items || []).map(item => ({
      id: item.id as string,
      name: item.name as string,
      type: item.type as RosterEntry['type'],
      status: item.status as RosterEntry['status'],
      joinedAt: item.joinedAt as string,
      agentConfig: item.agentConfig as RosterEntry['agentConfig'],
      systemPrompt: item.systemPrompt as string | undefined,
    }));
  }

  async function getRosterEntry(spaceId: string, channelId: string, participantId: string): Promise<RosterEntry | null> {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: {
        PK: `CHANNEL#${spaceId}#${channelId}`,
        SK: `ROSTER#${participantId}`,
      },
    }));

    if (!result.Item) return null;

    return {
      id: result.Item.id as string,
      name: result.Item.name as string,
      type: result.Item.type as RosterEntry['type'],
      status: result.Item.status as RosterEntry['status'],
      joinedAt: result.Item.joinedAt as string,
      agentConfig: result.Item.agentConfig as RosterEntry['agentConfig'],
      systemPrompt: result.Item.systemPrompt as string | undefined,
    };
  }

  async function updateRosterEntry(spaceId: string, channelId: string, participantId: string, update: Partial<RosterEntry>): Promise<void> {
    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (update.name !== undefined) {
      sets.push('#name = :name');
      names['#name'] = 'name';
      values[':name'] = update.name;
    }
    if (update.status !== undefined) {
      sets.push('#status = :status');
      names['#status'] = 'status';
      values[':status'] = update.status;
    }
    if (update.agentConfig !== undefined) {
      sets.push('agentConfig = :agentConfig');
      values[':agentConfig'] = update.agentConfig;
    }

    if (sets.length === 0) return;

    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: `CHANNEL#${spaceId}#${channelId}`,
        SK: `ROSTER#${participantId}`,
      },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
    }));
  }

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async function saveMessage(spaceId: string, message: StoredMessage): Promise<void> {
    // Compute TTL: 60 days from now (in epoch seconds)
    const ttl = Math.floor(Date.now() / 1000) + (60 * 24 * 60 * 60);

    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `CHANNEL#${spaceId}#${message.channelId}`,
        SK: `MSG#${message.id}`,
        spaceId,
        ttl,
        ...message,
        // Store addressedAgents as a DynamoDB Set for efficient contains() queries
        // If undefined or empty, don't store the attribute
        ...(message.addressedAgents && message.addressedAgents.length > 0
          ? { addressedAgents: new Set(message.addressedAgents) }
          : {}),
      },
    }));
  }

  async function getMessage(spaceId: string, messageId: string): Promise<StoredMessage | null> {
    // Note: This requires knowing the channelId. For now, we'd need a GSI.
    // For MVP, assume messages are always queried by channel.
    void spaceId;
    void messageId;
    throw new Error('getMessage by ID alone not supported - use getMessages with channelId');
  }

  async function getMessages(spaceId: string, channelId: string, params?: GetMessagesParams): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;

    let keyCondition = 'PK = :pk AND begins_with(SK, :sk)';
    const values: Record<string, unknown> = {
      ':pk': `CHANNEL#${spaceId}#${channelId}`,
    };

    // ULID comparison works lexicographically
    // Only add :sk when using begins_with, remove when using > or <
    if (params?.since) {
      keyCondition = 'PK = :pk AND SK > :since';
      values[':since'] = `MSG#${params.since}`;
    } else if (params?.before) {
      keyCondition = 'PK = :pk AND SK < :before';
      values[':before'] = `MSG#${params.before}`;
    } else {
      // Default: fetch all messages with MSG# prefix
      values[':sk'] = 'MSG#';
    }

    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ScanIndexForward: true, // Oldest first (ULID order)
      Limit: limit,
    }));

    return (result.Items || []).map(itemToMessage);
  }

  async function updateMessage(spaceId: string, messageId: string, update: Partial<StoredMessage>): Promise<void> {
    // Note: Requires channelId - for MVP, pass it in the update
    const channelId = (update as { channelId?: string }).channelId;
    if (!channelId) {
      throw new Error('channelId required for updateMessage in DynamoDB');
    }

    const sets: string[] = [];
    const values: Record<string, unknown> = {};

    if (update.content !== undefined) {
      sets.push('content = :content');
      values[':content'] = update.content;
    }
    if (update.isComplete !== undefined) {
      sets.push('isComplete = :isComplete');
      values[':isComplete'] = update.isComplete;
    }

    if (sets.length === 0) return;

    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: `CHANNEL#${spaceId}#${channelId}`,
        SK: `MSG#${messageId}`,
      },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
    }));
  }

  async function deleteMessage(spaceId: string, messageId: string): Promise<void> {
    // Note: Requires channelId - would need GSI for orphan deletion
    void spaceId;
    void messageId;
    throw new Error('deleteMessage by ID alone not supported - need channelId');
  }

  async function getAgentHistory(spaceId: string, channelId: string, params: GetAgentHistoryParams): Promise<StoredMessage[]> {
    const limit = params.limit ?? 100;

    // Query messages for the channel, then filter by addressedAgents OR sender
    // DynamoDB doesn't support direct Set contains in KeyConditionExpression,
    // so we use FilterExpression with contains()
    //
    // The filter returns:
    // 1. Messages @mentioning the agent (addressedAgents contains callsign)
    // 2. Messages @mentioning @channel (broadcast to all)
    // 3. Messages the agent sent (sender = callsign) - agent's own responses
    //
    // NOTE: The Limit parameter applies to items scanned, not items returned
    // after FilterExpression. This means if many messages exist but few match
    // the filter, we may return fewer than `limit` items. For high-traffic
    // channels, this should be enhanced with pagination (loop until limit
    // matching items are collected). Acceptable for launch load.
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: '(contains(addressedAgents, :callsign) OR contains(addressedAgents, :channel) OR sender = :callsign) AND #ts >= :since',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':pk': `CHANNEL#${spaceId}#${channelId}`,
        ':sk': 'MSG#',
        ':callsign': params.agentCallsign,
        ':channel': 'channel',
        ':since': params.sinceTimestamp,
      },
      ScanIndexForward: true, // Oldest first
      Limit: limit,
    }));

    return (result.Items || []).map(itemToMessage);
  }

  /**
   * Convert a DynamoDB item to a StoredMessage.
   * Handles conversion of DynamoDB Set back to array for addressedAgents.
   */
  function itemToMessage(item: Record<string, unknown>): StoredMessage {
    // DynamoDB Document Client returns Sets as JavaScript Sets
    const addressedAgents = item.addressedAgents instanceof Set
      ? Array.from(item.addressedAgents as Set<string>)
      : (item.addressedAgents as string[] | undefined);

    return {
      id: item.id as string,
      channelId: item.channelId as string,
      sender: item.sender as string,
      senderType: item.senderType as StoredMessage['senderType'],
      type: item.type as StoredMessage['type'],
      content: item.content,
      timestamp: item.timestamp as string,
      isComplete: item.isComplete as boolean,
      ...(addressedAgents && addressedAgents.length > 0 ? { addressedAgents } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Structured Ask Operations (stub - not yet implemented for DynamoDB)
  // ---------------------------------------------------------------------------

  async function saveStructuredAsk(_spaceId: string, _params: SaveStructuredAskParams): Promise<StoredMessage> {
    throw new Error('Structured ask operations not yet implemented for DynamoDB');
  }

  async function submitStructuredAskResponse(_spaceId: string, _params: SubmitStructuredAskParams): Promise<StoredMessage | null> {
    throw new Error('Structured ask operations not yet implemented for DynamoDB');
  }

  // ---------------------------------------------------------------------------
  // Attachment Operations (stub - not yet implemented for DynamoDB)
  // ---------------------------------------------------------------------------

  async function saveAttachment(_spaceId: string, _attachment: Attachment): Promise<void> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  async function getAttachment(_spaceId: string, _attachmentId: string): Promise<Attachment | null> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  async function getAttachments(_spaceId: string, _channelId: string, _params?: GetAttachmentsParams): Promise<Attachment[]> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  async function getMessageAttachments(_spaceId: string, _messageId: string): Promise<Attachment[]> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  async function linkAttachmentsToMessage(_spaceId: string, _messageId: string, _attachmentIds: string[]): Promise<void> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  async function deleteAttachment(_spaceId: string, _attachmentId: string): Promise<void> {
    throw new Error('Attachment operations not yet implemented for DynamoDB');
  }

  // ---------------------------------------------------------------------------
  // Knowledge Base Operations (stub - not yet implemented for DynamoDB)
  // ---------------------------------------------------------------------------

  async function listKnowledgeBases(_spaceId: string): Promise<KBMetadata[]> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function getKBDocument(_spaceId: string, _channel: string, _path: string): Promise<KBDocument | null> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function searchKB(_spaceId: string, _channel: string, _query: string, _options?: KBSearchOptions): Promise<KBSearchResult[]> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function indexKBDocument(_spaceId: string, _doc: KBDocument): Promise<void> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function removeKBDocument(_spaceId: string, _channel: string, _path: string): Promise<void> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function storeEmbedding(_spaceId: string, _artifactId: string, _channel: string, _embedding: number[]): Promise<void> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function searchByEmbedding(_spaceId: string, _embedding: number[], _options?: EmbeddingSearchOptions): Promise<EmbeddingSearchResult[]> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function deleteEmbedding(_spaceId: string, _artifactId: string): Promise<boolean> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  async function hasEmbedding(_spaceId: string, _artifactId: string): Promise<boolean> {
    throw new Error('KB operations not yet implemented for DynamoDB');
  }

  // ---------------------------------------------------------------------------
  // Artifact Operations
  // ---------------------------------------------------------------------------

  /**
   * Extract [[slug]] references from content.
   */
  function extractRefs(content: string): string[] {
    const refs: string[] = [];
    const regex = /\[\[([a-z0-9-]+(?:\.[a-z0-9]+)*)\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    return [...new Set(refs)]; // deduplicate
  }

  /**
   * Compute path from slug and parent chain.
   */
  async function computePath(spaceId: string, channelId: string, slug: string, parentSlug?: string): Promise<string> {
    if (!parentSlug) {
      return `/${slug}`;
    }
    const parent = await getArtifact(spaceId, channelId, parentSlug);
    if (!parent) {
      throw new Error(`Parent artifact not found: ${parentSlug}`); // Match SQLite behavior
    }
    return `${parent.path}/${slug}`;
  }

  /**
   * Get default status based on artifact type.
   */
  function getDefaultStatus(type: string): ArtifactStatus {
    if (type === 'task') {
      return 'pending';
    }
    return 'published';
  }

  async function createArtifact(spaceId: string, channelId: string, input: CreateArtifactInput): Promise<Artifact> {
    const now = new Date().toISOString();
    const id = ulid();
    const refs = extractRefs(input.content);
    const path = await computePath(spaceId, channelId, input.slug, input.parentSlug);
    const status = input.status || getDefaultStatus(input.type);

    const artifact: Artifact = {
      id,
      slug: input.slug,
      channelId,
      type: input.type,
      title: input.title,
      tldr: input.tldr,
      content: input.content,
      parentSlug: input.parentSlug,
      path,
      status,
      assignees: input.assignees || [],
      labels: input.labels || [],
      refs,
      props: input.props,
      version: 1,
      createdBy: input.createdBy,
      createdAt: now,
    };

    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const sk = `ARTIFACT#${input.slug}`;

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: pk,
          SK: sk,
          GSI1PK: `${pk}#ARTIFACTS`,
          GSI1SK: `TYPE#${artifact.type}#${artifact.slug}`,
          GSI2PK: `${pk}#ARTIFACTS`,
          GSI2SK: `STATUS#${artifact.status}#${artifact.slug}`,
          ...artifact,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return artifact;
  }

  async function getArtifact(spaceId: string, channelId: string, slug: string): Promise<Artifact | null> {
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const sk = `ARTIFACT#${slug}`;

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
      })
    );

    if (!result.Item) {
      return null;
    }

    const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...artifact } = result.Item;
    return artifact as Artifact;
  }

  async function updateArtifact(
    spaceId: string,
    channelId: string,
    slug: string,
    update: UpdateArtifactInput,
    updatedBy: string
  ): Promise<Artifact> {
    const existing = await getArtifact(spaceId, channelId, slug);
    if (!existing) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date().toISOString();
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const sk = `ARTIFACT#${slug}`;

    // Build update expression
    const updateParts: string[] = ['#updatedBy = :updatedBy', '#updatedAt = :updatedAt', '#version = #version + :one'];
    const exprAttrNames: Record<string, string> = {
      '#updatedBy': 'updatedBy',
      '#updatedAt': 'updatedAt',
      '#version': 'version',
    };
    const exprAttrValues: Record<string, unknown> = {
      ':updatedBy': updatedBy,
      ':updatedAt': now,
      ':one': 1,
    };

    if (update.title !== undefined) {
      updateParts.push('#title = :title');
      exprAttrNames['#title'] = 'title';
      exprAttrValues[':title'] = update.title;
    }
    if (update.tldr !== undefined) {
      updateParts.push('#tldr = :tldr');
      exprAttrNames['#tldr'] = 'tldr';
      exprAttrValues[':tldr'] = update.tldr;
    }
    if (update.content !== undefined) {
      const refs = extractRefs(update.content);
      updateParts.push('#content = :content', '#refs = :refs');
      exprAttrNames['#content'] = 'content';
      exprAttrNames['#refs'] = 'refs';
      exprAttrValues[':content'] = update.content;
      exprAttrValues[':refs'] = refs;
    }
    if (update.parentSlug !== undefined) {
      const path = await computePath(spaceId, channelId, slug, update.parentSlug || undefined);
      updateParts.push('#parentSlug = :parentSlug', '#path = :path');
      exprAttrNames['#parentSlug'] = 'parentSlug';
      exprAttrNames['#path'] = 'path';
      exprAttrValues[':parentSlug'] = update.parentSlug;
      exprAttrValues[':path'] = path;
    }
    if (update.status !== undefined) {
      updateParts.push('#status = :status', 'GSI2SK = :gsi2sk');
      exprAttrNames['#status'] = 'status';
      exprAttrValues[':status'] = update.status;
      exprAttrValues[':gsi2sk'] = `STATUS#${update.status}#${slug}`;
    }
    if (update.assignees !== undefined) {
      updateParts.push('#assignees = :assignees');
      exprAttrNames['#assignees'] = 'assignees';
      exprAttrValues[':assignees'] = update.assignees;
    }
    if (update.labels !== undefined) {
      updateParts.push('#labels = :labels');
      exprAttrNames['#labels'] = 'labels';
      exprAttrValues[':labels'] = update.labels;
    }
    if (update.props !== undefined) {
      updateParts.push('#props = :props');
      exprAttrNames['#props'] = 'props';
      exprAttrValues[':props'] = update.props;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames: exprAttrNames,
        ExpressionAttributeValues: exprAttrValues,
      })
    );

    const updated = await getArtifact(spaceId, channelId, slug);
    return updated!;
  }

  async function updateArtifactWithCAS(
    spaceId: string,
    channelId: string,
    slug: string,
    changes: CASChange[],
    updatedBy: string
  ): Promise<CASResult> {
    const existing = await getArtifact(spaceId, channelId, slug);
    if (!existing) {
      return {
        success: false,
        conflict: {
          field: 'slug',
          expected: slug,
          actual: null,
        },
      };
    }

    // Normalize values for CAS comparison: treat null and undefined as equivalent (match SQLite behavior)
    function normalizeCASValue(value: unknown): unknown {
      if (value === undefined || value === null) {
        return null;
      }
      return value;
    }

    // Validate all CAS conditions first
    for (const change of changes) {
      const currentValue = normalizeCASValue(existing[change.field]);
      const expectedValue = normalizeCASValue(change.oldValue);

      // Compare values (handle arrays and objects)
      const currentStr = JSON.stringify(currentValue);
      const expectedStr = JSON.stringify(expectedValue);

      if (currentStr !== expectedStr) {
        return {
          success: false,
          conflict: {
            field: change.field,
            expected: expectedValue,
            actual: currentValue,
          },
        };
      }
    }

    // Build update from changes
    const update: UpdateArtifactInput = {};
    for (const change of changes) {
      const field = change.field as keyof UpdateArtifactInput;
      if (field in update || ['title', 'tldr', 'content', 'parentSlug', 'status', 'assignees', 'labels', 'props'].includes(field)) {
        (update as Record<string, unknown>)[field] = change.newValue;
      }
    }

    const artifact = await updateArtifact(spaceId, channelId, slug, update, updatedBy);
    return { success: true, artifact };
  }

  async function archiveArtifact(spaceId: string, channelId: string, slug: string, updatedBy: string): Promise<Artifact> {
    return updateArtifact(spaceId, channelId, slug, { status: 'archived' }, updatedBy);
  }

  async function listArtifacts(spaceId: string, channelId: string, filters?: ListArtifactsParams): Promise<ArtifactSummary[]> {
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    let queryParams;

    if (filters?.type) {
      // Use GSI1 for type filtering
      queryParams = {
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :typePrefix)',
        ExpressionAttributeValues: {
          ':pk': `${pk}#ARTIFACTS`,
          ':typePrefix': `TYPE#${filters.type}#`,
        },
      };
    } else if (filters?.status) {
      // Use GSI2 for status filtering
      queryParams = {
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :statusPrefix)',
        ExpressionAttributeValues: {
          ':pk': `${pk}#ARTIFACTS`,
          ':statusPrefix': `STATUS#${filters.status}#`,
        },
      };
    } else {
      // Query all artifacts in channel
      queryParams = {
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':skPrefix': 'ARTIFACT#',
        },
      };
    }

    const result = await docClient.send(new QueryCommand(queryParams));
    let artifacts = (result.Items || [])
      .filter(item => !item.SK.includes('#VER#')) // Exclude versions
      .filter(item => filters?.status || item.status !== 'archived') // Exclude archived by default (match SQLite behavior)
      .map(item => ({
        slug: item.slug,
        path: item.path,
        type: item.type,
        title: item.title,
        status: item.status,
        tldr: item.tldr,
        assignees: item.assignees || [],
      })) as ArtifactSummary[];

    // Apply additional filters in memory
    if (filters?.assignee) {
      artifacts = artifacts.filter(a => a.assignees.includes(filters.assignee!));
    }
    if (filters?.parentSlug === 'root') {
      artifacts = artifacts.filter(a => a.path.split('/').length === 2); // /slug has 2 parts
    } else if (filters?.parentSlug) {
      // Would need to fetch full artifacts to check parentSlug
      // For now, filter by path prefix
      artifacts = artifacts.filter(a => a.path.startsWith(`/${filters.parentSlug}/`));
    }
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      artifacts = artifacts.filter(
        a =>
          a.slug.toLowerCase().includes(searchLower) ||
          a.title?.toLowerCase().includes(searchLower) ||
          a.tldr.toLowerCase().includes(searchLower)
      );
    }

    // Apply pagination
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;
    return artifacts.slice(offset, offset + limit);
  }

  async function globArtifacts(spaceId: string, channelId: string, pattern: string): Promise<ArtifactTreeNode[]> {
    // Fetch all artifacts and build tree in memory
    const allArtifacts = await listArtifacts(spaceId, channelId, { limit: 1000 });

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);

    // Filter by pattern
    const matching = allArtifacts.filter(a => regex.test(a.path));

    // Build tree structure
    const nodeMap = new Map<string, ArtifactTreeNode>();
    const roots: ArtifactTreeNode[] = [];

    for (const artifact of matching) {
      const node: ArtifactTreeNode = {
        slug: artifact.slug,
        path: artifact.path,
        type: artifact.type,
        title: artifact.title,
        status: artifact.status,
        assignees: artifact.assignees,
        children: [],
      };
      nodeMap.set(artifact.slug, node);
    }

    // Link children to parents
    for (const artifact of matching) {
      const pathParts = artifact.path.split('/').filter(Boolean);
      if (pathParts.length <= 1) {
        // Root level
        const node = nodeMap.get(artifact.slug);
        if (node) roots.push(node);
      } else {
        // Find parent by path
        const parentPath = '/' + pathParts.slice(0, -1).join('/');
        const parentArtifact = matching.find(a => a.path === parentPath);
        if (parentArtifact) {
          const parentNode = nodeMap.get(parentArtifact.slug);
          const childNode = nodeMap.get(artifact.slug);
          if (parentNode && childNode) {
            parentNode.children.push(childNode);
          }
        } else {
          // Parent not in results, treat as root
          const node = nodeMap.get(artifact.slug);
          if (node) roots.push(node);
        }
      }
    }

    return roots;
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
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const sk = `ARTIFACT#${slug}#VER#${versionName}`;

    const version: ArtifactVersion = {
      slug,
      versionName,
      versionMessage: message,
      versionCreatedAt: now,
      versionCreatedBy: createdBy,
      tldr: artifact.tldr,
      content: artifact.content,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: pk,
          SK: sk,
          ...version,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return version;
  }

  async function getArtifactVersion(
    spaceId: string,
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null> {
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const sk = `ARTIFACT#${slug}#VER#${versionName}`;

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
      })
    );

    if (!result.Item) {
      return null;
    }

    const { PK, SK, ...version } = result.Item;
    return version as ArtifactVersion;
  }

  async function listArtifactVersions(spaceId: string, channelId: string, slug: string): Promise<ArtifactVersion[]> {
    const pk = `CHANNEL#${spaceId}#${channelId}`;
    const skPrefix = `ARTIFACT#${slug}#VER#`;

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':skPrefix': skPrefix,
        },
      })
    );

    return (result.Items || []).map(item => ({
      slug: item.slug,
      versionName: item.versionName,
      versionMessage: item.versionMessage,
      versionCreatedAt: item.versionCreatedAt,
      versionCreatedBy: item.versionCreatedBy,
      tldr: item.tldr,
      content: item.content,
    })) as ArtifactVersion[];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    // DynamoDB tables are created via CloudFormation/CDK
    // This is a no-op for DynamoDB
    console.log('[DynamoDB] Storage initialized (tables managed externally)');
  }

  async function close(): Promise<void> {
    // DynamoDB client doesn't need explicit cleanup
    console.log('[DynamoDB] Storage closed');
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
