/**
 * MCP HTTP Transport Handler
 *
 * Exposes board operations (artifacts, messages) via MCP HTTP transport.
 * Enables containerized agents to call board tools directly via HTTP.
 *
 * Endpoints:
 * - POST /mcp/:channelId/tools/list - List available tools
 * - POST /mcp/:channelId/tools/call - Execute a tool
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

interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface McpHttpHandlerOptions {
  storage: Storage;
  spaceId: string;
}

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

export function createMcpRoutes(opts: McpHttpHandlerOptions): Hono<{ Variables: ContainerAuthVariables }> {
  const { storage, spaceId } = opts;
  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Apply container auth to all MCP routes
  app.use('*', requireContainerAuth());

  // POST /mcp/:channelId/tools/list
  app.post('/:channelId/tools/list', async (c) => {
    const channelId = c.req.param('channelId');

    // Verify channel exists
    const channel = await storage.getChannel(spaceId, channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    return c.json({ tools: TOOLS });
  });

  // POST /mcp/:channelId/tools/call
  app.post('/:channelId/tools/call', async (c) => {
    const channelId = c.req.param('channelId');
    const container = getContainerAuth(c);

    // Verify channel exists
    const channel = await storage.getChannel(spaceId, channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    let body: { name?: string; arguments?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: 'Invalid JSON body' }],
        isError: true,
      };
      return c.json(response, 400);
    }

    if (!body.name) {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: 'Missing tool name' }],
        isError: true,
      };
      return c.json(response, 400);
    }

    const handler = toolHandlers[body.name];
    if (!handler) {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: `Unknown tool: ${body.name}` }],
        isError: true,
      };
      return c.json(response, 400);
    }

    try {
      const ctx: ToolContext = {
        storage,
        spaceId,
        channelId,
        callsign: container.callsign,
      };
      const result = await handler(body.arguments ?? {}, ctx);
      const response: McpToolResponse = {
        content: [{ type: 'text', text: result }],
      };
      return c.json(response);
    } catch (err) {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
      // MCP returns 200 even for tool errors
      return c.json(response);
    }
  });

  return app;
}
