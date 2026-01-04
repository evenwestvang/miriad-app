/**
 * MCP HTTP Transport Handler
 *
 * Exposes board operations (artifacts, messages) via MCP HTTP transport.
 * Enables reactive agents to call board tools directly via HTTP.
 *
 * Endpoints:
 * - POST /mcp/:channelId/tools/list - List available tools
 * - POST /mcp/:channelId/tools/call - Execute a tool
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Storage } from '@cikada/storage';
import type { ArtifactStatus, ArtifactType } from '@cikada/local-runtime';

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
  broadcast: (channelId: string, frame: string) => Promise<void>;
}

// =============================================================================
// Tool Definitions
// =============================================================================

// Common channel property - note: for board MCP, channel is implicit from the URL
const channelProperty = {
  type: 'string',
  description: 'Optional channel ID override (defaults to URL channel)',
};

const TOOLS: McpToolDefinition[] = [
  {
    name: 'artifact_create',
    description: 'Create a new artifact on the Cikada board',
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
        createdBy: {
          type: 'string',
          description: 'Creator callsign',
        },
        channel: channelProperty,
      },
      required: ['slug', 'type', 'tldr', 'content', 'createdBy'],
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
        updatedBy: {
          type: 'string',
          description: 'Updater callsign',
        },
        channel: channelProperty,
      },
      required: ['slug', 'changes', 'updatedBy'],
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
        updatedBy: {
          type: 'string',
          description: 'Editor callsign',
        },
        channel: channelProperty,
      },
      required: ['slug', 'old_string', 'new_string', 'updatedBy'],
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
        updatedBy: {
          type: 'string',
          description: 'Archiver callsign',
        },
        channel: channelProperty,
      },
      required: ['slug', 'updatedBy'],
    },
  },
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
// Tree Formatting (matches mcp-artifact-server.ts)
// =============================================================================

interface ArtifactTreeNode {
  slug: string;
  path: string;
  type: string;
  title?: string;
  status: string;
  assignees: string[];
  children: ArtifactTreeNode[];
}

function formatTreeNode(node: ArtifactTreeNode, indent: number = 0): string {
  const parts: string[] = [];
  const indentStr = '  '.repeat(indent);

  const hasChildren = node.children && node.children.length > 0;
  const slug = hasChildren ? `/${node.slug}` : node.slug;
  parts.push(slug);

  if (node.type && node.type !== 'doc') {
    parts.push(`:${node.type}`);
  }

  if (node.status && node.status !== 'published') {
    parts.push(`(${node.status})`);
  }

  if (node.assignees && node.assignees.length > 0) {
    for (const assignee of node.assignees) {
      parts.push(`@${assignee}`);
    }
  }

  let result = indentStr + parts.join(' ');

  if (hasChildren) {
    for (const child of node.children) {
      result += '\n' + formatTreeNode(child, indent + 1);
    }
  }

  return result;
}

function formatTree(nodes: ArtifactTreeNode[]): string {
  if (!nodes || nodes.length === 0) {
    return '(empty)';
  }
  return nodes.map((node) => formatTreeNode(node, 0)).join('\n');
}

// =============================================================================
// Tool Implementations
// =============================================================================

interface ToolContext {
  opts: McpHttpHandlerOptions;
  channelId: string;
  spaceId: string;
}

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<string>;

const toolHandlers: Record<string, ToolHandler> = {
  async artifact_create(args, { opts: { storage, broadcast }, channelId, spaceId }) {
    const {
      slug,
      type,
      tldr,
      content,
      title,
      parentSlug,
      status,
      assignees,
      labels,
      createdBy,
      channel,
    } = args as {
      slug: string;
      type: string;
      tldr: string;
      content: string;
      title?: string;
      parentSlug?: string;
      status?: string;
      assignees?: string[];
      labels?: string[];
      createdBy: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;

    const artifact = await storage.createArtifact(spaceId, targetChannel, {
      slug,
      type: type as ArtifactType,
      tldr,
      content,
      title,
      parentSlug,
      status: (status ?? 'published') as ArtifactStatus,
      assignees,
      labels,
      createdBy,
    });

    // Broadcast artifact creation
    const frame = JSON.stringify({
      i: `artifact:${artifact.slug}`,
      t: artifact.createdAt,
      v: { type: 'artifact', action: 'created', artifact },
    });
    await broadcast(targetChannel, frame);

    return JSON.stringify(artifact, null, 2);
  },

  async artifact_read(args, { opts: { storage }, channelId, spaceId }) {
    const { slug, channel } = args as { slug: string; channel?: string };
    const targetChannel = channel || channelId;

    const artifact = await storage.getArtifact(spaceId, targetChannel, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    return JSON.stringify(artifact, null, 2);
  },

  async artifact_list(args, { opts: { storage }, channelId, spaceId }) {
    const { type, status, assignee, parentSlug, search, limit, offset, channel } = args as {
      type?: string;
      status?: string;
      assignee?: string;
      parentSlug?: string;
      search?: string;
      limit?: number;
      offset?: number;
      channel?: string;
    };

    const targetChannel = channel || channelId;
    const filters: Record<string, unknown> = {};

    if (type) filters.type = type;
    if (status) filters.status = status;
    if (assignee) filters.assignee = assignee;
    if (parentSlug) filters.parentSlug = parentSlug;
    if (search) filters.search = search;
    if (limit) filters.limit = limit;
    if (offset) filters.offset = offset;

    const artifacts = await storage.listArtifacts(spaceId, targetChannel, filters as any);

    return JSON.stringify({ artifacts }, null, 2);
  },

  async artifact_glob(args, { opts: { storage }, channelId, spaceId }) {
    const { pattern, channel } = args as { pattern?: string; channel?: string };
    const targetChannel = channel || channelId;
    const globPattern = pattern ?? '/**';

    const tree = await storage.globArtifacts(spaceId, targetChannel, globPattern);

    return formatTree(tree as ArtifactTreeNode[]);
  },

  async artifact_update(args, { opts: { storage, broadcast }, channelId, spaceId }) {
    const { slug, changes, updatedBy, channel } = args as {
      slug: string;
      changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
      updatedBy: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;

    // Transform to storage CAS format
    const casChanges = changes.map((c) => ({
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
    }));

    const result = await storage.updateArtifactWithCAS(spaceId, targetChannel, slug, casChanges as any, updatedBy);

    if (!result.success) {
      return JSON.stringify(
        { success: false, error: 'CAS conflict', conflict: result.conflict },
        null,
        2
      );
    }

    // Broadcast update
    const frame = JSON.stringify({
      i: `artifact:${result.artifact!.slug}`,
      t: result.artifact!.updatedAt,
      v: { type: 'artifact', action: 'updated', artifact: result.artifact },
    });
    await broadcast(targetChannel, frame);

    return JSON.stringify(result.artifact, null, 2);
  },

  async artifact_edit(args, { opts: { storage, broadcast }, channelId, spaceId }) {
    const { slug, old_string, new_string, updatedBy, channel } = args as {
      slug: string;
      old_string: string;
      new_string: string;
      updatedBy: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;

    // Read current artifact
    const artifact = await storage.getArtifact(spaceId, targetChannel, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const content = artifact.content ?? '';

    // Check that old_string exists exactly once
    const matches = content.split(old_string).length - 1;
    if (matches === 0) {
      throw new Error('old_string not found in artifact content');
    }
    if (matches > 1) {
      throw new Error(`old_string matches ${matches} times (ambiguous) - use a longer string`);
    }

    // Replace and update with CAS
    const newContent = content.replace(old_string, new_string);

    const result = await storage.updateArtifactWithCAS(
      spaceId,
      targetChannel,
      slug,
      [{ field: 'content', oldValue: content, newValue: newContent }] as any,
      updatedBy
    );

    if (!result.success) {
      return JSON.stringify(
        { success: false, error: 'Content was modified by someone else (CAS conflict)', conflict: result.conflict },
        null,
        2
      );
    }

    // Broadcast update
    const frame = JSON.stringify({
      i: `artifact:${result.artifact!.slug}`,
      t: result.artifact!.updatedAt,
      v: { type: 'artifact', action: 'updated', artifact: result.artifact },
    });
    await broadcast(targetChannel, frame);

    return JSON.stringify(result.artifact, null, 2);
  },

  async artifact_archive(args, { opts: { storage, broadcast }, channelId, spaceId }) {
    const { slug, updatedBy, channel } = args as {
      slug: string;
      updatedBy: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;

    const artifact = await storage.archiveArtifact(spaceId, targetChannel, slug, updatedBy);

    // Broadcast archive
    const frame = JSON.stringify({
      i: `artifact:${artifact.slug}`,
      t: artifact.updatedAt,
      v: { type: 'artifact', action: 'archived', artifact },
    });
    await broadcast(targetChannel, frame);

    return JSON.stringify({ archived: true, artifact }, null, 2);
  },

  async message_get(args, { opts: { storage }, channelId, spaceId }) {
    const { limit, before, since, channel } = args as {
      limit?: number;
      before?: string;
      since?: string;
      channel?: string;
    };

    const targetChannel = channel || channelId;
    const msgLimit = limit ?? 50;

    // Use storage to get messages (returns StoredMessage[] directly)
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

  async message_search(args, { opts: { storage }, channelId, spaceId }) {
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
// HTTP Handler
// =============================================================================

export function createMcpHttpHandler(opts: McpHttpHandlerOptions) {
  /**
   * Handle MCP HTTP requests
   *
   * Routes:
   * - POST /mcp/:channelId/tools/list
   * - POST /mcp/:channelId/tools/call
   *
   * Returns true if request was handled, false otherwise.
   */
  return async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathParts: string[],
    spaceId: string
  ): Promise<boolean> {
    // Check if this is an MCP route
    if (pathParts[0] !== 'mcp' || !pathParts[1]) {
      return false;
    }

    const channelId = pathParts[1];
    const endpoint = pathParts[2];

    // Verify channel exists and belongs to space
    const channel = await opts.storage.getChannel(spaceId, channelId);
    if (!channel) {
      jsonResponse(res, 404, { error: 'Channel not found' });
      return true;
    }

    // POST /mcp/:channelId/tools/list
    if (req.method === 'POST' && endpoint === 'tools' && pathParts[3] === 'list') {
      jsonResponse(res, 200, { tools: TOOLS });
      return true;
    }

    // POST /mcp/:channelId/tools/call
    if (req.method === 'POST' && endpoint === 'tools' && pathParts[3] === 'call') {
      const body = await readBody<{ name: string; arguments?: Record<string, unknown> }>(req);

      if (!body.name) {
        const response: McpToolResponse = {
          content: [{ type: 'text', text: 'Missing tool name' }],
          isError: true,
        };
        jsonResponse(res, 400, response);
        return true;
      }

      const handler = toolHandlers[body.name];
      if (!handler) {
        const response: McpToolResponse = {
          content: [{ type: 'text', text: `Unknown tool: ${body.name}` }],
          isError: true,
        };
        jsonResponse(res, 400, response);
        return true;
      }

      try {
        const ctx: ToolContext = { opts, channelId, spaceId };
        const result = await handler(body.arguments ?? {}, ctx);
        const response: McpToolResponse = {
          content: [{ type: 'text', text: result }],
        };
        jsonResponse(res, 200, response);
      } catch (err) {
        const response: McpToolResponse = {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
        jsonResponse(res, 200, response); // MCP returns 200 even for tool errors
      }

      return true;
    }

    // Unknown MCP route
    jsonResponse(res, 404, { error: 'Unknown MCP endpoint' });
    return true;
  };
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
