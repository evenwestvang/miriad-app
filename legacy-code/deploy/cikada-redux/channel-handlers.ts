/**
 * Lambda Channel Handlers
 *
 * Channel API handlers for AWS Lambda/API Gateway.
 * Implements: list channels, create channel, get channel, messages, roster.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { jwtVerify } from 'jose';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { createDynamoDbStorage } from '@cikada/storage/dynamodb';
import type { Storage } from '@cikada/storage';
import { ulid } from 'ulid';
import { broadcastToChannel } from './channel-broadcast.js';
import { tymbal } from '@cikada/reactive-agent';

// Import from @cikada/handlers for channel operations
import {
  createChannel as createChannelFn,
  addAgentToChannel,
  removeAgentFromChannel,
  type ArtifactReader,
  type ChannelStorage,
  type ChannelHandlerContext,
} from '@cikada/handlers';

// =============================================================================
// Constants
// =============================================================================

const ROOT_CHANNEL_NAME = 'root';

const COOKIE_NAME = 'cikada-session';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';

// =============================================================================
// Initialization
// =============================================================================

let storage: Storage | null = null;

/**
 * Initialize storage for Lambda.
 * Called once per cold start.
 */
function initStorage(): Storage {
  if (storage) return storage;

  const mainTable = process.env.MAIN_TABLE;
  if (!mainTable) {
    console.error('[Channels] MAIN_TABLE not configured');
    throw new Error('MAIN_TABLE environment variable not set');
  }

  const region = process.env.AWS_REGION || 'us-east-1';

  storage = createDynamoDbStorage({
    region,
    tableName: mainTable,
  });

  console.log(`[Channels] Storage initialized (table: ${mainTable})`);
  return storage;
}

// =============================================================================
// Auth Helpers
// =============================================================================

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[Channels] WARNING: SESSION_SECRET not set, using insecure default');
    return new TextEncoder().encode(DEFAULT_SECRET);
  }
  return new TextEncoder().encode(secret);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  }

  return cookies;
}

interface SessionPayload {
  userId: string;
  spaceId: string;
}

/**
 * Verify session from cookie and return user/space info.
 */
async function verifySession(event: APIGatewayProxyEventV2): Promise<SessionPayload> {
  const cookies = parseCookies(event.cookies?.join('; '));
  const token = cookies[COOKIE_NAME];

  if (!token) {
    throw new Error('No session token');
  }

  const { payload } = await jwtVerify(token, getSecret());

  if (!payload.sub || !payload.spaceId) {
    throw new Error('Invalid session payload');
  }

  return {
    userId: payload.sub,
    spaceId: payload.spaceId as string,
  };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return jsonResponse(statusCode, { error: message });
}

// =============================================================================
// Handler Adapters
// =============================================================================

/**
 * Derive API URL from request context or environment.
 * Used for MCP server URLs that need the API base URL.
 */
function getApiUrl(event: APIGatewayProxyEventV2): string {
  if (process.env.API_URL) {
    return process.env.API_URL;
  }
  const host = event.headers?.host || event.requestContext?.domainName;
  const stage = event.requestContext?.stage;
  if (host && stage) {
    return `https://${host}/${stage}`;
  }
  console.warn('[Channels] Could not derive API_URL from request context, using localhost fallback');
  return 'http://localhost:3001';
}

/**
 * Create an ArtifactReader adapter that wraps DynamoDB storage.
 * Used by handler functions to resolve agent/MCP definitions.
 */
function createArtifactReader(storageInstance: Storage, spaceId: string): ArtifactReader {
  return {
    read: (channelId: string, slug: string) =>
      storageInstance.getArtifact(spaceId, channelId, slug),
  };
}

/**
 * Create a ChannelStorage adapter that wraps DynamoDB storage.
 * Bridges the @cikada/storage interface to @cikada/handlers' ChannelStorage interface.
 */
function createChannelStorage(storageInstance: Storage): ChannelStorage {
  return {
    createChannel: async (spaceId: string, input: Parameters<ChannelStorage['createChannel']>[1]) => {
      const result = await storageInstance.createChannel(spaceId, input);
      return result as unknown as ReturnType<ChannelStorage['createChannel']> extends Promise<infer T> ? T : never;
    },
    getChannel: async (spaceId: string, channelId: string) => {
      const result = await storageInstance.getChannel(spaceId, channelId);
      return result as unknown as ReturnType<ChannelStorage['getChannel']> extends Promise<infer T> ? T : never;
    },
    listChannels: async (spaceId: string) => {
      const result = await storageInstance.listChannels(spaceId);
      return result as unknown as ReturnType<ChannelStorage['listChannels']> extends Promise<infer T> ? T : never;
    },
    updateChannelStatus: (spaceId: string, channelId: string, status: 'active' | 'archived') =>
      storageInstance.updateChannelStatus(spaceId, channelId, status),
    getRoster: async (spaceId: string, channelId: string) => {
      const result = await storageInstance.getRoster(spaceId, channelId);
      return result as unknown as ReturnType<ChannelStorage['getRoster']> extends Promise<infer T> ? T : never;
    },
    addToRoster: (spaceId: string, channelId: string, entry: Parameters<ChannelStorage['addToRoster']>[2]) =>
      storageInstance.addToRoster(spaceId, channelId, entry as any),
    removeFromRoster: (spaceId: string, channelId: string, participantId: string) =>
      storageInstance.removeFromRoster(spaceId, channelId, participantId),
    saveMessage: (spaceId: string, msg: Parameters<ChannelStorage['saveMessage']>[1]) =>
      storageInstance.saveMessage(spaceId, msg as any),
  };
}

/**
 * Get root channel ID for artifact lookups.
 */
async function getRootChannelId(storageInstance: Storage, spaceId: string): Promise<string | null> {
  const rootChannel = await storageInstance.getChannelByName(spaceId, ROOT_CHANNEL_NAME);
  return rootChannel?.id ?? null;
}

// =============================================================================
// Channel Handlers
// =============================================================================

/**
 * GET /channels - List all channels in user's space
 */
export async function listChannelsHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const includeArchived = event.queryStringParameters?.includeArchived === 'true';
    const channels = await storageInstance.listChannels(spaceId, { includeArchived });

    return jsonResponse(200, { channels });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] listChannels error:', error);
    return errorResponse(500, 'Failed to list channels');
  }
}

/**
 * POST /channels - Create a new channel
 *
 * If focusSlug is provided, looks up the focus artifact to:
 * - Apply default tagline/mission if not overridden
 * - Spawn default agents defined in the focus's props.agents array
 * - Set the channel leader to the first agent
 */
export async function createChannelHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const body = JSON.parse(event.body);
    const { name, description, focusSlug, tagline, mission } = body;

    if (!name) {
      return errorResponse(400, 'Channel name required');
    }

    // Check if channel with this name already exists
    const existing = await storageInstance.getChannelByName(spaceId, name);
    if (existing) {
      return errorResponse(409, `Channel "${name}" already exists`);
    }

    // Build context and options for handler
    const channelStorage = createChannelStorage(storageInstance);
    const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId };
    const rootChannelId = await getRootChannelId(storageInstance, spaceId);

    // Create resolve options with env defaults from API Gateway context
    const resolveOptions = {
      envDefaults: {
        CIKADA_API_URL: getApiUrl(event),
      },
    };

    const result = await createChannelFn(ctx, {
      name,
      description,
      focusSlug,
      tagline,
      mission,
    }, {
      artifactReader: createArtifactReader(storageInstance, spaceId),
      rootChannelId: rootChannelId ?? undefined,
      resolveOptions,
    });

    console.log(`[Channels] Created channel: ${result.channel.id} (${name}), spawned: ${result.spawnedAgents.join(',') || 'none'}`);
    return jsonResponse(201, { channel: result.channel });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] createChannel error:', error);
    return errorResponse(500, 'Failed to create channel');
  }
}

/**
 * GET /channels/{id} - Get channel details with roster
 */
export async function getChannelHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    // Get full roster entries
    const roster = await storageInstance.getRoster(spaceId, channelId);

    return jsonResponse(200, { channel, roster });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] getChannel error:', error);
    return errorResponse(500, 'Failed to get channel');
  }
}

/**
 * DELETE /channels/{id} - Archive a channel
 */
export async function archiveChannelHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    await storageInstance.updateChannelStatus(spaceId, channelId, 'archived');

    console.log(`[Channels] Archived channel: ${channelId}`);
    return jsonResponse(200, { success: true });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] archiveChannel error:', error);
    return errorResponse(500, 'Failed to archive channel');
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

/**
 * GET /channels/{id}/messages - Get messages for a channel
 */
export async function getMessagesHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    const since = event.queryStringParameters?.since;
    const before = event.queryStringParameters?.before;
    const limit = event.queryStringParameters?.limit
      ? parseInt(event.queryStringParameters.limit, 10)
      : 50;

    const messages = await storageInstance.getMessages(spaceId, channelId, {
      since,
      before,
      limit,
    });

    return jsonResponse(200, { messages });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] getMessages error:', error);
    return errorResponse(500, 'Failed to get messages');
  }
}

/**
 * POST /channels/{id}/messages - Send a message to a channel
 */
export async function sendMessageHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId, userId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const body = JSON.parse(event.body);
    const { content, sender } = body;

    if (!content) {
      return errorResponse(400, 'Message content required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    const messageId = ulid();
    const now = new Date().toISOString();

    // Parse @mentions from content
    const mentionRegex = /@(\w+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }

    const message = {
      id: messageId,
      channelId,
      sender: sender || userId,
      senderType: 'human' as const,
      type: 'message' as const,
      content,
      timestamp: now,
      isComplete: true,
      ...(mentions.length > 0 ? { addressedAgents: mentions } : {}),
    };

    await storageInstance.saveMessage(spaceId, message);

    console.log(`[Channels] Message sent: ${messageId} in ${channelId}`);

    // Broadcast message to all connected WebSocket clients
    const frame = tymbal.set(messageId, {
      type: message.type,
      sender: message.sender,
      senderType: message.senderType,
      content: message.content,
      timestamp: message.timestamp,
      mentions: mentions,
    });
    await broadcastToChannel(spaceId, channelId, frame);
    console.log(`[Channels] Broadcast complete for ${messageId}`);

    // Invoke agent(s) based on mentions or leader fallback
    const agentFunctionArn = process.env.REACTIVE_AGENT_FUNCTION_ARN;
    if (agentFunctionArn) {
      const roster = await storageInstance.getRoster(spaceId, channelId);
      const agentsToInvoke: typeof roster = [];

      // Filter out @channel from specific agent mentions (case-insensitive)
      const agentMentions = mentions
        .filter((m) => m.toLowerCase() !== 'channel')
        .map((m) => m.toLowerCase());

      if (agentMentions.length > 0) {
        // Explicit @mentions: invoke mentioned agents (case-insensitive match)
        // Note: r.id is the callsign (e.g., "fox"), r.name is display name
        const mentionedAgents = roster.filter(
          (r) => r.type === 'agent' && agentMentions.includes(r.id.toLowerCase())
        );
        agentsToInvoke.push(...mentionedAgents);
      } else if (mentions.map((m) => m.toLowerCase()).includes('channel')) {
        // @channel: invoke ALL agents in roster
        const allAgents = roster.filter((r) => r.type === 'agent');
        agentsToInvoke.push(...allAgents);
      } else if (channel.leader) {
        // No mentions: invoke leader only
        // Leader is stored as channel.leader (callsign string), match against roster id
        const leaderAgent = roster.find((r) => r.type === 'agent' && r.id === channel.leader);
        if (leaderAgent) {
          agentsToInvoke.push(leaderAgent);
        }
      }

      // Invoke agent Lambda for each agent (async/fire-and-forget)
      if (agentsToInvoke.length > 0) {
        const lambdaClient = new LambdaClient({});
        for (const agent of agentsToInvoke) {
          // Get system prompt from roster entry (captured at spawn time)
          const systemPrompt =
            agent.systemPrompt ||
            agent.agentConfig?.system ||
            'You are a helpful assistant.';

          console.log(`[Channels] Invoking agent ${agent.id} for message ${messageId}`);
          try {
            await lambdaClient.send(
              new InvokeCommand({
                FunctionName: agentFunctionArn,
                InvocationType: InvocationType.Event, // Async
                Payload: Buffer.from(
                  JSON.stringify({
                    spaceId,
                    channelId,
                    agentCallsign: agent.id,
                    sinceTimestamp: agent.joinedAt || new Date().toISOString(),
                    userMessage: content,
                    systemPrompt,
                    mcpServers: agent.agentConfig?.mcpServers || [],
                  })
                ),
              })
            );
          } catch (err) {
            console.error(`[Channels] Failed to invoke agent ${agent.id}:`, err);
            // Don't fail the request if agent invoke fails
          }
        }
      }
    }

    return jsonResponse(201, { message });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] sendMessage error:', error);
    return errorResponse(500, 'Failed to send message');
  }
}

// =============================================================================
// Roster Handlers
// =============================================================================

/**
 * POST /channels/{id}/agents - Add an agent to the channel roster
 */
export async function addAgentHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const body = JSON.parse(event.body);
    const { callsign, agentType } = body;

    if (!callsign) {
      return errorResponse(400, 'Agent callsign required');
    }

    if (!agentType) {
      return errorResponse(400, 'Agent type (definition slug) required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    // Build context and options for handler
    const channelStorage = createChannelStorage(storageInstance);
    const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId };
    const rootChannelId = await getRootChannelId(storageInstance, spaceId);

    // Create resolve options with env defaults from API Gateway context
    const resolveOptions = {
      envDefaults: {
        CIKADA_API_URL: getApiUrl(event),
      },
    };

    try {
      const result = await addAgentToChannel(ctx, channelId, {
        agentType,
        callsign,
      }, {
        artifactReader: createArtifactReader(storageInstance, spaceId),
        rootChannelId: rootChannelId ?? undefined,
        resolveOptions,
      });

      console.log(`[Channels] Added agent to roster: ${callsign} in ${channelId}`);
      return jsonResponse(201, { entry: result.entry });
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        return errorResponse(409, err.message);
      }
      throw err;
    }
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] addAgent error:', error);
    return errorResponse(500, 'Failed to add agent');
  }
}

/**
 * DELETE /channels/{id}/agents/{callsign} - Remove an agent from the roster
 */
export async function removeAgentHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const callsign = event.pathParameters?.callsign;

    if (!channelId || !callsign) {
      return errorResponse(400, 'Channel ID and callsign required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    // Build context for handler
    const channelStorage = createChannelStorage(storageInstance);
    const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId };

    try {
      await removeAgentFromChannel(ctx, channelId, callsign);
      console.log(`[Channels] Removed agent from roster: ${callsign} in ${channelId}`);
      return jsonResponse(200, { success: true });
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return errorResponse(404, err.message);
      }
      if (err.message?.includes('leader')) {
        return errorResponse(400, err.message);
      }
      throw err;
    }
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Channels] removeAgent error:', error);
    return errorResponse(500, 'Failed to remove agent');
  }
}
