/**
 * Local Agent WebSocket Handler
 *
 * Handles WebSocket connections from local-agent-engine clients.
 * Manages agent registration, message routing, and Tymbal frame relay.
 *
 * Protocol: See [[local-agent-ws-protocol]] artifact
 *
 * Stage 1: No authentication - trusts localhost connections.
 */

import type { WebSocket } from 'ws';
import {
  parseFrame,
  isSetFrame,
  isResetFrame,
  tymbal,
  generateMessageId,
  type TymbalFrame,
  type SetFrame,
} from '@cast/core';
import type { Storage } from '@cast/storage';
import type { ConnectionManager } from '../websocket/index.js';
import { verifyContainerToken } from '../auth/index.js';
import { createServerAuthVerifier, type ServerAuthResult } from './local-agent-auth.js';

// =============================================================================
// Types
// =============================================================================

/** Protocol version */
const PROTOCOL_VERSION = '1';

/** Message types from client (upstream) */
interface RegisterMessage {
  type: 'register';
  channelId: string;
  callsign: string;
  workspace?: string;
  token?: string; // Agent token (required in prod, optional in dev)
}

interface FrameMessage {
  type: 'frame';
  channelId: string;
  token?: string; // Agent token for validation
  frame: TymbalFrame;
}

type ClientMessage = RegisterMessage | FrameMessage;

/** Message types to client (downstream) */
interface ConnectedMessage {
  type: 'connected';
  version: string;
}

interface RegisteredMessage {
  type: 'registered';
  callsign: string;
  channelId: string;
}

interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

interface AgentMessage {
  type: 'message';
  id: string;
  channelId: string;
  callsign: string;
  content: string;
  sender: string;
  systemPrompt: string;
}

type ServerMessage = ConnectedMessage | RegisteredMessage | ErrorMessage | AgentMessage;

/** Connection state for a local agent */
interface LocalAgentConnection {
  ws: WebSocket;
  callsign: string | null;
  channelId: string | null;
  workspace: string | null;
  token: string | null; // Agent token for frame validation
  serverAuth: ServerAuthResult | null; // Server auth (if connected with server credentials)
  connectedAt: Date;
}

// =============================================================================
// Local Agent Manager
// =============================================================================

export interface LocalAgentManagerOptions {
  /** Storage backend for roster and channels */
  storage: Storage;
  /** Connection manager for broadcasting Tymbal frames */
  connectionManager: ConnectionManager;
  /** Callback to build system prompt for an agent */
  buildSystemPrompt?: (spaceId: string, channelId: string, callsign: string) => Promise<string>;
  /** Whether to require auth (false for localhost dev, true for production) */
  requireAuth?: boolean;
}

export interface LocalAgentManager {
  /** Handle a new WebSocket connection */
  handleConnection(ws: WebSocket, authHeader?: string): void | Promise<void>;
  /** Send a message to a specific local agent */
  sendToAgent(channelId: string, callsign: string, message: AgentMessage): boolean;
  /** Check if a local agent is connected */
  isAgentConnected(channelId: string, callsign: string): boolean;
  /** Get all connected local agents */
  getConnectedAgents(): Array<{ channelId: string; callsign: string; workspace: string | null }>;
  /** Close all connections */
  closeAll(): void;
}

/**
 * Create a local agent manager.
 */
export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  const { storage, connectionManager, buildSystemPrompt, requireAuth = false } = options;

  // Create auth verifier with storage backend
  const verifyServerAuth = createServerAuthVerifier(storage);

  // Track connections by channelId:callsign
  const connections = new Map<string, LocalAgentConnection>();

  function getConnectionKey(channelId: string, callsign: string): string {
    return `${channelId}:${callsign}`;
  }

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendError(ws: WebSocket, code: string, message: string): void {
    send(ws, { type: 'error', code, message });
  }

  async function handleRegister(
    connection: LocalAgentConnection,
    message: RegisterMessage
  ): Promise<void> {
    const { channelId, callsign, workspace } = message;

    // Validate required fields
    if (!channelId || !callsign) {
      sendError(connection.ws, 'INVALID_MESSAGE', 'channelId and callsign are required');
      return;
    }

    // Check if already registered with different credentials
    if (connection.callsign && (connection.callsign !== callsign || connection.channelId !== channelId)) {
      sendError(connection.ws, 'ALREADY_REGISTERED', 'Connection already registered with different credentials');
      return;
    }

    // Check if callsign is already taken in this channel by another connection
    const key = getConnectionKey(channelId, callsign);
    const existing = connections.get(key);
    if (existing && existing.ws !== connection.ws) {
      sendError(connection.ws, 'ALREADY_REGISTERED', `Callsign "${callsign}" already registered in channel`);
      return;
    }

    try {
      // Look up channel to get spaceId
      const channel = await storage.getChannelById(channelId);
      if (!channel) {
        sendError(connection.ws, 'CHANNEL_NOT_FOUND', `Channel "${channelId}" not found`);
        return;
      }

      // Validate agent token (required in prod, optional in dev)
      if (requireAuth) {
        if (!message.token) {
          sendError(connection.ws, 'AUTH_REQUIRED', 'Agent token required');
          return;
        }

        const tokenPayload = verifyContainerToken(message.token);
        if (!tokenPayload) {
          sendError(connection.ws, 'INVALID_TOKEN', 'Invalid agent token');
          return;
        }

        // Verify token matches request
        if (tokenPayload.channelId !== channelId || tokenPayload.callsign !== callsign) {
          sendError(connection.ws, 'TOKEN_MISMATCH', 'Token does not match channelId/callsign');
          return;
        }

        // Verify channel belongs to token's space
        if (tokenPayload.spaceId !== channel.spaceId) {
          sendError(connection.ws, 'SPACE_MISMATCH', 'Token space does not match channel space');
          return;
        }

        // Store token for frame validation
        connection.token = message.token;
      }

      // Check if callsign already exists in roster (cloud agent)
      const existingRoster = await storage.getRosterByCallsign(channelId, callsign);
      if (existingRoster && existingRoster.callbackUrl) {
        // Already a cloud agent with this callsign
        sendError(connection.ws, 'ALREADY_REGISTERED', `Callsign "${callsign}" already exists as cloud agent`);
        return;
      }

      // Add to roster if not exists, or update if exists without callbackUrl
      if (!existingRoster) {
        await storage.addToRoster({
          channelId,
          callsign,
          agentType: 'local', // Mark as local agent
          status: 'active',
        });
        console.log(`[LocalAgents] Added ${callsign} to roster in channel ${channelId}`);
      } else {
        // Update status to active
        await storage.updateRosterEntry(channelId, existingRoster.id, {
          status: 'active',
        });
        console.log(`[LocalAgents] Reactivated ${callsign} in channel ${channelId}`);
      }

      // Update connection state
      connection.callsign = callsign;
      connection.channelId = channelId;
      connection.workspace = workspace ?? null;

      // Register in our connection map
      connections.set(key, connection);

      // Send registered confirmation
      send(connection.ws, {
        type: 'registered',
        callsign,
        channelId,
      });

      // Broadcast status message to channel
      const statusFrame = tymbal.set(generateMessageId(), {
        type: 'status',
        sender: 'system',
        senderType: 'agent',
        content: `${callsign} joined (local agent)`,
      });
      await connectionManager.broadcast(channelId, statusFrame);

      console.log(`[LocalAgents] Registered ${callsign} in channel ${channelId}${workspace ? ` (workspace: ${workspace})` : ''}`);
    } catch (error) {
      console.error('[LocalAgents] Registration error:', error);
      sendError(connection.ws, 'REGISTRATION_FAILED', 'Failed to register agent');
    }
  }

  async function handleFrame(
    connection: LocalAgentConnection,
    message: FrameMessage
  ): Promise<void> {
    // Must be registered first
    if (!connection.callsign || !connection.channelId) {
      sendError(connection.ws, 'NOT_REGISTERED', 'Must register before sending frames');
      return;
    }

    const { channelId, frame } = message;

    // Verify channel matches registration
    if (channelId !== connection.channelId) {
      sendError(connection.ws, 'CHANNEL_MISMATCH', 'Frame channelId does not match registration');
      return;
    }

    // Validate token on each frame (if auth required)
    if (requireAuth) {
      const frameToken = message.token ?? connection.token;
      if (!frameToken) {
        sendError(connection.ws, 'AUTH_REQUIRED', 'Agent token required');
        return;
      }

      const tokenPayload = verifyContainerToken(frameToken);
      if (!tokenPayload || tokenPayload.channelId !== channelId || tokenPayload.callsign !== connection.callsign) {
        sendError(connection.ws, 'INVALID_TOKEN', 'Invalid or mismatched agent token');
        return;
      }
    }

    try {
      // Serialize and broadcast the frame
      const serialized = JSON.stringify(frame);
      await connectionManager.broadcast(channelId, serialized);

      // Persist SetFrames as messages
      if (isSetFrame(frame)) {
        const channel = await storage.getChannelById(channelId);
        if (channel && frame.v && typeof frame.v === 'object') {
          const value = frame.v as Record<string, unknown>;
          await storage.saveMessage({
            id: frame.i,
            spaceId: channel.spaceId,
            channelId,
            sender: (value.sender as string) ?? connection.callsign,
            senderType: 'agent',
            type: ((value.type as string) ?? 'agent') as 'user' | 'agent' | 'tool_call' | 'tool_result' | 'thinking' | 'status' | 'error' | 'idle',
            content: value.content ?? value,
            isComplete: true,
            metadata: { fromLocalAgent: true, workspace: connection.workspace },
          });
        }
      }
    } catch (error) {
      console.error('[LocalAgents] Frame processing error:', error);
      // Don't send error to client for frame processing failures - just log
    }
  }

  async function handleDisconnect(connection: LocalAgentConnection): Promise<void> {
    if (!connection.callsign || !connection.channelId) {
      return;
    }

    const key = getConnectionKey(connection.channelId, connection.callsign);
    connections.delete(key);

    try {
      // Update roster status to offline
      const rosterEntry = await storage.getRosterByCallsign(connection.channelId, connection.callsign);
      if (rosterEntry) {
        await storage.updateRosterEntry(connection.channelId, rosterEntry.id, {
          status: 'offline',
        });
      }

      // Broadcast departure message
      const statusFrame = tymbal.set(generateMessageId(), {
        type: 'status',
        sender: 'system',
        senderType: 'agent',
        content: `${connection.callsign} left (local agent disconnected)`,
      });
      await connectionManager.broadcast(connection.channelId, statusFrame);

      console.log(`[LocalAgents] ${connection.callsign} disconnected from channel ${connection.channelId}`);
    } catch (error) {
      console.error('[LocalAgents] Disconnect cleanup error:', error);
    }
  }

  return {
    async handleConnection(ws: WebSocket, authHeader?: string): Promise<void> {
      // Parse server auth from Authorization header (if provided)
      const serverAuth = authHeader ? await verifyServerAuth(authHeader) : null;

      // If auth required but no valid server auth, reject immediately
      if (requireAuth && !serverAuth) {
        send(ws, { type: 'error', code: 'AUTH_REQUIRED', message: 'Server authentication required' });
        ws.close(4001, 'Authentication required');
        console.log('[LocalAgents] Connection rejected: no valid server auth');
        return;
      }

      const connection: LocalAgentConnection = {
        ws,
        callsign: null,
        channelId: null,
        workspace: null,
        token: null,
        serverAuth,
        connectedAt: new Date(),
      };

      // Send connected message immediately
      send(ws, { type: 'connected', version: PROTOCOL_VERSION });
      console.log(`[LocalAgents] New connection established${serverAuth ? ` (server: ${serverAuth.serverId})` : ' (dev mode)'}`);

      // Handle incoming messages
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString()) as ClientMessage;

          switch (message.type) {
            case 'register':
              await handleRegister(connection, message);
              break;

            case 'frame':
              await handleFrame(connection, message);
              break;

            default:
              sendError(ws, 'INVALID_MESSAGE', `Unknown message type: ${(message as { type: string }).type}`);
          }
        } catch (error) {
          console.error('[LocalAgents] Message handling error:', error);
          sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        handleDisconnect(connection);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('[LocalAgents] WebSocket error:', error);
        handleDisconnect(connection);
      });
    },

    sendToAgent(channelId: string, callsign: string, message: AgentMessage): boolean {
      const key = getConnectionKey(channelId, callsign);
      const connection = connections.get(key);

      if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
        return false;
      }

      send(connection.ws, message);
      return true;
    },

    isAgentConnected(channelId: string, callsign: string): boolean {
      const key = getConnectionKey(channelId, callsign);
      const connection = connections.get(key);
      return !!connection && connection.ws.readyState === connection.ws.OPEN;
    },

    getConnectedAgents(): Array<{ channelId: string; callsign: string; workspace: string | null }> {
      const agents: Array<{ channelId: string; callsign: string; workspace: string | null }> = [];

      for (const connection of connections.values()) {
        if (connection.callsign && connection.channelId && connection.ws.readyState === connection.ws.OPEN) {
          agents.push({
            channelId: connection.channelId,
            callsign: connection.callsign,
            workspace: connection.workspace,
          });
        }
      }

      return agents;
    },

    closeAll(): void {
      for (const connection of connections.values()) {
        if (connection.ws.readyState === connection.ws.OPEN) {
          connection.ws.close();
        }
      }
      connections.clear();
    },
  };
}
