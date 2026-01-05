/**
 * MCP HTTP Transport Handler (JSON-RPC)
 *
 * Exposes board operations (artifacts, messages) via MCP HTTP transport.
 * Implements JSON-RPC 2.0 protocol for MCP compatibility.
 *
 * Endpoint:
 * - POST /mcp/:channel - JSON-RPC endpoint for all MCP operations
 *
 * JSON-RPC Methods:
 * - tools/list - List available tools
 * - tools/call - Execute a tool
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import {
  requireContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from '../auth/container-middleware.js';

// =============================================================================
// Types
// =============================================================================

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpHttpHandlerOptions {
  storage: Storage;
  spaceId: string;
}

// JSON-RPC error codes
const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// =============================================================================
// Tool Definitions
// =============================================================================

const channelProperty = {
  type: 'string',
  description: 'Optional channel ID override (defaults to URL channel)',
};

const TOOLS: McpToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Artifact Tools
  // ---------------------------------------------------------------------------
  {
    name: 'artifact_create',
    description: 'Create a new artifact on the board',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: "Immutable identifier (e.g., 'auth-api-spec', 'config.json')",
        },
        type: {
          type: 'string',
          enum: ['doc', 'task', 'decision', 'code', 'asset'],
          description: 'Artifact type',
        },
        tldr: {
          type: 'string',
          description: '1-3 sentence summary',
        },
        content: {
          type: 'string',
          description: 'Markdown for docs, raw code for code artifacts',
        },
        title: {
          type: 'string',
          description: 'Optional display name',
        },
        parentSlug: {
          type: 'string',
          description: 'Parent artifact for tree structure',
        },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'pending', 'in_progress', 'done', 'blocked'],
          description: 'Artifact status',
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent callsigns (for tasks)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Freeform tags',
        },
        channel: channelProperty,
      },
      required: ['slug', 'type', 'tldr', 'content'],
    },
  },
  {
    name: 'artifact_read',
    description: "Read a single artifact's full content",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to read',
        },
        channel: channelProperty,
      },
      required: ['slug'],
    },
  },
  {
    name: 'artifact_list',
    description: 'Query artifacts with filters. Returns summaries (not full content)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Filter by type',
        },
        status: {
          type: 'string',
          description: 'Filter by status',
        },
        assignee: {
          type: 'string',
          description: 'Filter tasks by assignee',
        },
        parentSlug: {
          type: 'string',
          description: "'root' for top-level, or specific parent slug",
        },
        search: {
          type: 'string',
          description: 'Keyword search (slug, title, tldr, content)',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 50)',
        },
        offset: {
          type: 'number',
          description: 'For pagination',
        },
        channel: channelProperty,
      },
    },
  },
  {
    name: 'artifact_glob',
    description: 'Get tree view of artifacts matching a glob pattern',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: "Glob pattern (default: '/**'). Examples: '/**', '/auth-system/**', '/**/*.ts', '/*'",
        },
        channel: channelProperty,
      },
    },
  },
  {
    name: 'artifact_update',
    description:
      'Atomic update with compare-and-swap (CAS) for conflict prevention. All changes are atomic - all succeed or all fail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to update',
        },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Field name: title, tldr, status, content, parentSlug, assignees, labels',
              },
              oldValue: {
                description: 'Expected current value (null if unset)',
              },
              newValue: {
                description: 'New value to set',
              },
            },
            required: ['field', 'oldValue', 'newValue'],
          },
          description: 'Array of field changes with CAS',
        },
        channel: channelProperty,
      },
      required: ['slug', 'changes'],
    },
  },
  {
    name: 'artifact_edit',
    description:
      'Surgical find-replace on content. Returns error if old_string not found or matches multiple times.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to edit',
        },
        old_string: {
          type: 'string',
          description: 'Text to find (must match exactly once)',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
        channel: channelProperty,
      },
      required: ['slug', 'old_string', 'new_string'],
    },
  },
  {
    name: 'artifact_archive',
    description: "Soft delete - sets status to 'archived'",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to archive',
        },
        channel: channelProperty,
      },
      required: ['slug'],
    },
  },
  // ---------------------------------------------------------------------------
  // Message Tools
  // ---------------------------------------------------------------------------
  {
    name: 'message_get',
    description: 'Get recent messages from the channel. Supports cursor-based pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: channelProperty,
        limit: {
          type: 'number',
          description: 'Max messages to return (default: 50)',
        },
        before: {
          type: 'string',
          description: 'Return messages before this ULID (for pagination)',
        },
        since: {
          type: 'string',
          description: 'Return messages after this ULID (for sync/updates)',
        },
      },
    },
  },
  {
    name: 'message_search',
    description: 'Search messages by keyword and/or sender. Client-side filtering on recent messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: channelProperty,
        query: {
          type: 'string',
          description: 'Keyword to search for in message content (case-insensitive)',
        },
        sender: {
          type: 'string',
          description: 'Filter by sender callsign (exact match, case-insensitive)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 100)',
        },
      },
    },
  },
];

// =============================================================================
// Tool Handlers
// =============================================================================

interface ToolContext {
  storage: Storage;
  spaceId: string;
  channelId: string;
  callsign: string;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

const toolHandlers: Record<string, ToolHandler> = {
  // ---------------------------------------------------------------------------
  // Artifact Tools (stubs for now)
  // ---------------------------------------------------------------------------

  async artifact_create(_args, _ctx) {
    // Write operation - return error
    throw new Error('artifact_create not yet implemented - storage layer pending');
  },

  async artifact_read(args, _ctx) {
    // Read operation - return empty/not found
    const { slug } = args as { slug: string };
    throw new Error(`Artifact not found: ${slug}`);
  },

  async artifact_list(_args, _ctx) {
    // Read operation - return empty list
    return JSON.stringify({ artifacts: [] }, null, 2);
  },

  async artifact_glob(_args, _ctx) {
    // Read operation - return empty tree
    return '(empty)';
  },

  async artifact_update(_args, _ctx) {
    // Write operation - return error
    throw new Error('artifact_update not yet implemented - storage layer pending');
  },

  async artifact_edit(_args, _ctx) {
    // Write operation - return error
    throw new Error('artifact_edit not yet implemented - storage layer pending');
  },

  async artifact_archive(_args, _ctx) {
    // Write operation - return error
    throw new Error('artifact_archive not yet implemented - storage layer pending');
  },

  // ---------------------------------------------------------------------------
  // Message Tools (fully implemented)
  // ---------------------------------------------------------------------------

  async message_get(args, { storage, spaceId, channelId }) {
    const { limit, before, since, channel } = args as {
      limit?: number;
      before?: string;
      since?: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;
    const msgLimit = limit ?? 50;

    const messages = await storage.getMessages(spaceId, targetChannel, {
      limit: msgLimit,
      before,
      since,
    });

    const formatted = messages.map((msg) => ({
      id: msg.id,
      sender: msg.sender,
      senderType: msg.senderType,
      timestamp: msg.timestamp,
      content: msg.content,
    }));

    const cursor = messages.length > 0 ? messages[messages.length - 1].id : undefined;

    return JSON.stringify({ count: formatted.length, cursor, messages: formatted }, null, 2);
  },

  async message_search(args, { storage, spaceId, channelId }) {
    const { query, sender, limit, channel } = args as {
      query?: string;
      sender?: string;
      limit?: number;
      channel?: string;
    };

    const targetChannel = channel || channelId;
    const msgLimit = limit ?? 100;

    // Fetch more messages to filter client-side
    const fetchLimit = Math.min(msgLimit * 3, 500);
    let messages = await storage.getMessages(spaceId, targetChannel, { limit: fetchLimit });

    // Client-side filtering
    if (sender) {
      const senderLower = sender.toLowerCase();
      messages = messages.filter((msg) => msg.sender.toLowerCase() === senderLower);
    }

    if (query) {
      const queryLower = query.toLowerCase();
      messages = messages.filter((msg) => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return content.toLowerCase().includes(queryLower);
      });
    }

    // Apply limit after filtering
    messages = messages.slice(0, msgLimit);

    const formatted = messages.map((msg) => ({
      id: msg.id,
      sender: msg.sender,
      senderType: msg.senderType,
      timestamp: msg.timestamp,
      content: msg.content,
    }));

    return JSON.stringify({ count: formatted.length, messages: formatted }, null, 2);
  },
};

// =============================================================================
// Route Factory
// =============================================================================

/**
 * Resolve channel by name first, then by ID.
 * This allows agents to use friendly channel names in URLs.
 */
async function resolveChannel(storage: Storage, spaceId: string, channelIdOrName: string) {
  // Try by name first (more user-friendly)
  const byName = await storage.getChannelByName(spaceId, channelIdOrName);
  if (byName) return byName;

  // Fall back to ID lookup
  return storage.getChannel(spaceId, channelIdOrName);
}

/**
 * Create JSON-RPC error response
 */
function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

/**
 * Create JSON-RPC success response
 */
function jsonRpcSuccess(id: string | number, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function createMcpRoutes(opts: McpHttpHandlerOptions): Hono<{ Variables: ContainerAuthVariables }> {
  const { storage, spaceId } = opts;
  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Apply container auth to all MCP routes
  app.use('*', requireContainerAuth());

  // POST /mcp/:channel - Single JSON-RPC endpoint
  app.post('/:channel', async (c) => {
    const channelIdOrName = c.req.param('channel');
    const container = getContainerAuth(c);

    // Resolve channel by name or ID
    const channel = await resolveChannel(storage, spaceId, channelIdOrName);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    // Parse JSON-RPC request
    let request: JsonRpcRequest;
    try {
      request = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, JSONRPC_ERRORS.PARSE_ERROR, 'Parse error: Invalid JSON'));
    }

    // Validate JSON-RPC request
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      return c.json(jsonRpcError(request.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: Missing or invalid jsonrpc version'));
    }

    if (!request.method || typeof request.method !== 'string') {
      return c.json(jsonRpcError(request.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: Missing method'));
    }

    if (request.id === undefined) {
      return c.json(jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: Missing id'));
    }

    // Route by method
    switch (request.method) {
      case 'initialize': {
        // MCP initialization handshake
        return c.json(jsonRpcSuccess(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'cast-mcp',
            version: '0.0.1',
          },
        }));
      }

      case 'notifications/initialized': {
        // Client acknowledgment - no response needed for notifications
        return c.json(jsonRpcSuccess(request.id, {}));
      }

      case 'tools/list': {
        return c.json(jsonRpcSuccess(request.id, { tools: TOOLS }));
      }

      case 'tools/call': {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;

        if (!params?.name) {
          return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: Missing tool name'));
        }

        const handler = toolHandlers[params.name];
        if (!handler) {
          return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${params.name}`));
        }

        try {
          const ctx: ToolContext = {
            storage,
            spaceId,
            channelId: channel.id,
            callsign: container.callsign,
          };
          const result = await handler(params.arguments ?? {}, ctx);

          // Return MCP tool result format
          return c.json(jsonRpcSuccess(request.id, {
            content: [{ type: 'text', text: result }],
          }));
        } catch (err) {
          // Tool errors are returned as successful JSON-RPC with isError in result
          return c.json(jsonRpcSuccess(request.id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }));
        }
      }

      default:
        return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${request.method}`));
    }
  });

  return app;
}
