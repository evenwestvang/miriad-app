/**
 * Agent Checkin Handler (Protocol v3.0)
 *
 * POST /agents/checkin - Container registers its callback URL on startup
 *
 * Flow:
 * 1. Container POSTs { protocolVersion, agentId, endpoint, routeHints, capabilities }
 * 2. API validates protocolVersion (must be "3.0")
 * 3. API stores endpoint + routeHints, marks container ready
 * 4. API queries pending messages (since readmark)
 * 5. API POSTs compiled messages to callback URL
 * 6. On success, updates readmark
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import type { StoredMessage } from '@cast/core';
import { tymbal, generateMessageId } from '@cast/core';
import type { AgentRuntime, AgentMessage } from '@cast/runtime';
import { parseAgentId } from '@cast/runtime';
import { generateContainerToken } from '../auth/index.js';
import type { ConnectionManager } from '../websocket/index.js';

// =============================================================================
// Types (v3.0 Protocol)
// =============================================================================

/**
 * v3.0 Checkin request format.
 * Container sends this on startup to register itself.
 */
export interface CheckinRequestV3 {
  /** Protocol version - MUST be "3.0" */
  protocolVersion: string;
  /** Agent identity: {spaceId}:{channelId}:{callsign} */
  agentId: string;
  /** Container callback URL (from CAST_CALLBACK_URL env var) */
  endpoint: string;
  /** Routing hints to echo as HTTP headers (e.g., { "fly-force-instance-id": "abc123" }) */
  routeHints?: Record<string, string> | null;
  /** Container capabilities (e.g., ["route-hints"]) */
  capabilities?: string[];
}

/**
 * v3.0 Heartbeat request format.
 * Container sends this periodically (~30s) to signal it's alive.
 * Note: endpoint is NOT allowed in heartbeat - routing is immutable after checkin.
 */
export interface HeartbeatRequestV3 {
  /** Agent identity: {spaceId}:{channelId}:{callsign} */
  agentId: string;
}

/** System prompt builder function type */
export type SystemPromptBuilder = (spaceId: string, channelId: string, callsign: string) => Promise<string>;

export interface CheckinHandlerOptions {
  /** Storage backend */
  storage: Storage;
  /** Default space ID */
  spaceId: string;
  /** Agent runtime for local Docker (uses port mapping instead of callbackUrl) */
  runtime?: AgentRuntime;
  /** WebSocket connection manager for broadcasting state changes */
  connectionManager?: ConnectionManager;
  /** Build system prompt for an agent (provided by AgentManager) */
  buildSystemPrompt?: SystemPromptBuilder;
}

// =============================================================================
// Message Compilation
// =============================================================================

/**
 * Compile multiple messages into a single content string with headers.
 *
 * Format:
 * --- @sender in #channel says:
 * message content
 *
 * --- @sender2 in #channel says:
 * another message
 */
export function compileMessages(
  messages: StoredMessage[],
  channelName: string
): string {
  if (messages.length === 0) {
    return '';
  }

  // Always compile with headers for consistency
  return messages
    .map((msg) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      return `--- @${msg.sender} in #${channelName} says:\n${content}`;
    })
    .join('\n\n');
}

/**
 * Get messages pending delivery for an agent.
 * Returns messages where:
 * - id > readmark (or all if no readmark)
 * - callsign is in addressedAgents array
 */
export async function getPendingMessages(
  storage: Storage,
  spaceId: string,
  channelId: string,
  callsign: string,
  readmark: string | null
): Promise<StoredMessage[]> {
  // Get messages since readmark
  const allMessages = await storage.getMessages(spaceId, channelId, {
    since: readmark ?? undefined,
    limit: 100, // Reasonable limit
  });

  // Filter to messages addressed to this agent
  return allMessages.filter((msg) => {
    if (!msg.addressedAgents || msg.addressedAgents.length === 0) {
      return false;
    }
    return msg.addressedAgents.includes(callsign);
  });
}

/**
 * Push messages to container callback URL.
 *
 * @param endpoint - Container callback URL (e.g., http://10.0.1.45:8080)
 * @param compiledContent - Compiled message content
 * @param agentId - Agent ID for the conversation
 * @param authToken - Auth token for the container (generated via generateContainerToken)
 * @param systemPrompt - Optional system prompt to include
 * @param routeHints - Optional routing hints to echo as HTTP headers
 */
export async function pushMessagesToContainer(
  endpoint: string,
  compiledContent: string,
  agentId: string,
  authToken?: string,
  systemPrompt?: string,
  routeHints?: Record<string, string> | null
): Promise<boolean> {
  try {
    const url = `${endpoint}/message`;
    const body: { content: string; agentId: string; systemPrompt?: string } = {
      content: compiledContent,
      agentId,
    };
    if (systemPrompt) {
      body.systemPrompt = systemPrompt;
    }

    console.log(`[Checkin] Pushing message to ${url}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    // Echo routeHints as HTTP headers (for Fly.io instance routing, etc.)
    if (routeHints) {
      for (const [key, value] of Object.entries(routeHints)) {
        headers[key] = value;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Checkin] Push failed: ${response.status}`);
      console.error(`[Checkin] Response body: ${error}`);
      console.error(`[Checkin] Request URL: ${url}`);
      console.error(`[Checkin] Request headers:`, JSON.stringify(headers, null, 2));
      return false;
    }

    console.log(`[Checkin] Push successful`);
    return true;
  } catch (error) {
    console.error(`[Checkin] Push error:`, error);
    return false;
  }
}

// =============================================================================
// Route Handler
// =============================================================================

// Heartbeat staleness threshold (60 seconds)
export const HEARTBEAT_STALE_MS = 60_000;

/**
 * Check if a heartbeat timestamp is stale (older than threshold).
 */
export function isHeartbeatStale(lastHeartbeat: string | null | undefined): boolean {
  if (!lastHeartbeat) return true;
  const lastTime = new Date(lastHeartbeat).getTime();
  return Date.now() - lastTime > HEARTBEAT_STALE_MS;
}

/**
 * Broadcast an agent_state frame to all WebSocket clients in a channel.
 * For 'online' state, includes lastHeartbeat so clients can track offline timeout.
 * For 'pending' state, includes lastMessageRoutedAt so clients can track pending timeout.
 */
export async function broadcastAgentState(
  connectionManager: ConnectionManager | undefined,
  channelId: string,
  callsign: string,
  state: 'connecting' | 'online' | 'offline' | 'paused' | 'resumed' | 'pending' | 'dismissed',
  timestamp?: string
): Promise<void> {
  if (!connectionManager) return;

  const value: Record<string, unknown> = {
    type: 'agent_state',
    sender: callsign,
    state,
  };

  // Include timestamp for client-side timeout tracking
  // - 'online': lastHeartbeat for offline timeout
  // - 'pending': lastMessageRoutedAt for pending timeout
  if (timestamp) {
    if (state === 'online') {
      value.lastHeartbeat = timestamp;
    } else if (state === 'pending') {
      value.lastMessageRoutedAt = timestamp;
    }
  }

  // Build frame with channel ID directly (avoid string manipulation bugs)
  const frame = {
    i: generateMessageId(),
    t: new Date().toISOString(),
    v: value,
    c: channelId,
  };

  await connectionManager.broadcast(channelId, JSON.stringify(frame));
  console.log(`[AgentState] Broadcast ${state} for ${callsign} in ${channelId}`);
}

/**
 * Create the /agents routes (v3.0 protocol).
 */
export function createCheckinRoutes(options: CheckinHandlerOptions): Hono {
  const { storage, spaceId: defaultSpaceId, runtime, connectionManager, buildSystemPrompt } = options;

  const app = new Hono();

  /**
   * POST /agents/checkin (v3.0 protocol)
   *
   * Container calls this on startup to register its callback URL.
   * API validates protocol version, stores endpoint + routeHints, then pushes pending messages.
   */
  app.post('/checkin', async (c) => {
    let body: CheckinRequestV3;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // v3.0: Validate protocol version
    if (body.protocolVersion !== '3.0') {
      console.error(`[Checkin] Rejected - unsupported protocol version: ${body.protocolVersion}`);
      return c.json({ error: 'Unsupported protocol version. Expected "3.0"' }, 400);
    }

    const { agentId, endpoint, routeHints, capabilities } = body;

    if (!agentId || !endpoint) {
      return c.json(
        { error: 'agentId and endpoint are required' },
        400
      );
    }

    // Parse agentId to get components
    let spaceId: string;
    let channelId: string;
    let callsign: string;
    try {
      const parsed = parseAgentId(agentId);
      spaceId = parsed.spaceId;
      channelId = parsed.channelId;
      callsign = parsed.callsign;
    } catch (err) {
      console.error(`[Checkin] Invalid agentId format: ${agentId}`);
      return c.json({ error: 'Invalid agentId format. Expected {spaceId}:{channelId}:{callsign}' }, 400);
    }

    console.log(`[Checkin] Agent ${callsign} checking in (protocol v3.0)`);
    console.log(`[Checkin]   agentId: ${agentId}`);
    console.log(`[Checkin]   endpoint: ${endpoint}`);
    console.log(`[Checkin]   routeHints: ${routeHints ? JSON.stringify(routeHints) : '(none)'}`);
    console.log(`[Checkin]   capabilities: ${capabilities?.join(', ') || '(none)'}`);

    // Store callback URL and routeHints in roster table
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      console.error(`[Checkin] Agent ${callsign} not found in roster for channel ${channelId}`);
      return c.json({ error: 'Agent not found in roster' }, 404);
    }

    // Persist callbackUrl and routeHints to roster
    //
    // TECH DEBT: Current approach is brittle - we conditionally skip routeHints update
    // if container sends null, to preserve FlyRuntime's pre-populated real machine ID.
    //
    // Better architecture would be:
    // - rosterEntry.runtimeRouteHints: set by runtime (FlyRuntime stores real Fly machine ID)
    // - rosterEntry.containerRouteHints: set by container during checkin
    // - Message routing merges both, with runtime hints taking precedence for platform-specific routing
    //
    // This would cleanly separate concerns and avoid the implicit "don't overwrite if null" behavior.
    const now = new Date().toISOString();
    const updatePayload: { callbackUrl: string; lastHeartbeat: string; routeHints?: Record<string, string> | null } = {
      callbackUrl: endpoint,
      lastHeartbeat: now,
    };
    if (routeHints) {
      updatePayload.routeHints = routeHints;
    }
    await storage.updateRosterEntry(channelId, rosterEntry.id, updatePayload);
    console.log(`[Checkin] Stored callbackUrl for ${callsign} in roster`);
    console.log(`[Checkin]   Previous callbackUrl: ${rosterEntry.callbackUrl ?? '(none)'}`);
    console.log(`[Checkin]   New callbackUrl: ${endpoint}`);
    console.log(`[Checkin]   RouteHints: ${routeHints ? JSON.stringify(routeHints) : 'preserved from roster'}`);

    // Broadcast online state
    await broadcastAgentState(connectionManager, channelId, callsign, 'online', now);

    // Get readmark from roster entry (persisted in DB)
    const readmark = rosterEntry.readmark ?? null;

    // Block on pending message delivery before returning
    // (Lambda freezes async work after response is sent)
    let delivered = 0;
    try {
      // Get pending messages
      const pendingMessages = await getPendingMessages(
        storage,
        spaceId,
        channelId,
        callsign,
        readmark
      );

      if (pendingMessages.length === 0) {
        console.log(`[Checkin] No pending messages for ${callsign}`);
      } else {
        console.log(
          `[Checkin] ${pendingMessages.length} pending message(s) for ${callsign}`
        );

        // Get channel name for message headers
        const channel = await storage.getChannel(spaceId, channelId);
        const channelName = channel?.name ?? channelId;

        // Compile messages
        const compiledContent = compileMessages(pendingMessages, channelName);

        let success = false;

        // Build system prompt if builder is provided
        const systemPrompt = buildSystemPrompt
          ? await buildSystemPrompt(spaceId, channelId, callsign)
          : undefined;

        // For local Docker, use runtime's port mapping (bypasses host.docker.internal issue)
        if (runtime?.isOnline(agentId)) {
          console.log(`[Checkin] Using runtime for pending message delivery`);
          try {
            const message: AgentMessage = { content: compiledContent, systemPrompt };
            await runtime.sendMessage(agentId, message);
            success = true;
          } catch (error) {
            console.error(`[Checkin] Runtime push failed:`, error);
          }
        } else {
          // Remote path: use container's reported endpoint
          // Generate auth token for this agent (deterministic - same as container received at activate)
          const authToken = generateContainerToken({ spaceId, channelId, callsign });

          // Push to container (blocking), include routeHints as headers
          success = await pushMessagesToContainer(
            endpoint,
            compiledContent,
            agentId,
            authToken,
            systemPrompt,
            routeHints
          );
        }

        if (success) {
          delivered = pendingMessages.length;
          // Update readmark to latest message ID (persisted in roster)
          const latestMessageId = pendingMessages[pendingMessages.length - 1].id;
          await storage.updateRosterEntry(channelId, rosterEntry.id, {
            readmark: latestMessageId,
          });
          console.log(`[Checkin] Updated readmark to ${latestMessageId}`);
        }
      }
    } catch (error) {
      console.error(`[Checkin] Error pushing messages:`, error);
    }

    return c.json({ ok: true, agentId, delivered });
  });

  /**
   * POST /agents/heartbeat (v3.0 protocol)
   *
   * Container calls this periodically (~30s) to signal it's alive.
   * Updates lastHeartbeat timestamp in roster.
   * Note: endpoint is NOT allowed in heartbeat - routing is immutable after checkin.
   */
  app.post('/heartbeat', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // v3.0: Reject heartbeats that include endpoint field
    // (Callback URL is immutable after checkin - prevents accidental routing corruption)
    if ('endpoint' in body) {
      console.error(`[Heartbeat] Rejected - endpoint field not allowed in heartbeat`);
      return c.json({ error: 'endpoint not allowed in heartbeat' }, 400);
    }

    const { agentId } = body as unknown as HeartbeatRequestV3;

    if (!agentId || typeof agentId !== 'string') {
      return c.json(
        { error: 'agentId is required' },
        400
      );
    }

    // Parse agentId to get channelId and callsign
    let channelId: string;
    let callsign: string;
    try {
      const parsed = parseAgentId(agentId);
      channelId = parsed.channelId;
      callsign = parsed.callsign;
    } catch (err) {
      console.error(`[Heartbeat] Invalid agentId format: ${agentId}`);
      return c.json({ error: 'Invalid agentId format' }, 400);
    }

    // Find roster entry
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      console.error(`[Heartbeat] Agent ${callsign} not found in roster for channel ${channelId}`);
      return c.json({ error: 'Agent not found in roster' }, 404);
    }

    // Check if agent was offline (stale heartbeat) before this heartbeat
    const wasOffline = isHeartbeatStale(rosterEntry.lastHeartbeat);

    // Update lastHeartbeat only (no callbackUrl update in v3.0)
    const now = new Date().toISOString();
    await storage.updateRosterEntry(channelId, rosterEntry.id, {
      lastHeartbeat: now,
    });

    // Only broadcast 'online' if agent is not paused or archived
    // Paused/archived agents should not send online events (their state is user-controlled)
    if (rosterEntry.status !== 'paused' && rosterEntry.status !== 'archived') {
      await broadcastAgentState(connectionManager, channelId, callsign, 'online', now);
    }

    console.log(`[Heartbeat] Agent ${callsign} (${agentId}) - heartbeat at ${now}${wasOffline ? ' (now online)' : ''}${rosterEntry.status === 'paused' ? ' (muted)' : ''}`);

    return c.json({ ok: true, timestamp: now });
  });

  /**
   * GET /agents/status/:agentId
   *
   * Check agent status. agentId is URL-encoded (colons become %3A).
   */
  app.get('/status/:agentId', async (c) => {
    const agentIdParam = c.req.param('agentId');
    const agentId = decodeURIComponent(agentIdParam);

    // Parse agentId
    let channelId: string;
    let callsign: string;
    try {
      const parsed = parseAgentId(agentId);
      channelId = parsed.channelId;
      callsign = parsed.callsign;
    } catch (err) {
      return c.json({ error: 'Invalid agentId format' }, 400);
    }

    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    const endpoint = rosterEntry?.callbackUrl ?? null;
    const isOnline = !!endpoint && !isHeartbeatStale(rosterEntry?.lastHeartbeat);

    return c.json({
      agentId,
      status: isOnline ? 'online' : 'offline',
      endpoint: isOnline ? endpoint : null,
      lastActivity: rosterEntry?.lastHeartbeat ?? null,
    });
  });

  return app;
}
