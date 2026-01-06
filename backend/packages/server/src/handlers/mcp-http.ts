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
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Storage } from '@cast/storage';
import {
  requireContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from '../auth/container-middleware.js';
import type { AssetStorage } from '../assets/index.js';

// =============================================================================
// Instruction Loading (Phase F)
// =============================================================================

interface Instruction {
  id: string;
  summary: string;
  content: string;
}

/**
 * Load instruction markdown files from the defaults/instructions directory.
 * Files have YAML frontmatter with a `summary` field.
 */
function loadInstructions(): Map<string, Instruction> {
  const instructions = new Map<string, Instruction>();

  // Get path relative to this file
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const instructionsDir = path.join(__dirname, '../defaults/instructions');

  if (!fsSync.existsSync(instructionsDir)) {
    console.warn('[MCP] Instructions directory not found:', instructionsDir);
    return instructions;
  }

  const files = fsSync.readdirSync(instructionsDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const content = fsSync.readFileSync(path.join(instructionsDir, file), 'utf-8');
    const slug = file.replace(/\.md$/, '');

    // Parse YAML frontmatter: ---\n...\n---\n content
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (match) {
      // Extract summary from frontmatter
      const frontmatter = match[1];
      const summaryMatch = frontmatter.match(/summary:\s*(.+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : slug;

      instructions.set(slug, {
        id: slug,
        summary,
        content: match[2].trim(),
      });
    } else {
      // No frontmatter - use file content as-is
      instructions.set(slug, {
        id: slug,
        summary: slug,
        content: content.trim(),
      });
    }
  }

  console.log(`[MCP] Loaded ${instructions.size} instruction articles:`, Array.from(instructions.keys()).join(', '));
  return instructions;
}

// Load instructions at module initialization
const instructions = loadInstructions();

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
  assetStorage?: AssetStorage;
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
          enum: ['doc', 'folder', 'task', 'decision', 'code'],
          description: 'Artifact type (use upload_asset tool for binary files like images/PDFs)',
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
      'Atomic metadata update with compare-and-swap (CAS) for conflict prevention. All changes are atomic - all succeed or all fail. For content changes, use artifact_edit instead.',
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
                description: 'Field name: title, tldr, status, parentSlug, orderKey, assignees, labels, props',
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
  {
    name: 'artifact_checkpoint',
    description: 'Create a named version snapshot. Snapshots current content and tldr. Versions are immutable once created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to checkpoint',
        },
        version: {
          type: 'string',
          description: "Version name (e.g., 'v1.0', 'draft-2', 'final')",
        },
        message: {
          type: 'string',
          description: "Version message (e.g., 'Addressed security feedback')",
        },
        channel: channelProperty,
      },
      required: ['slug', 'version'],
    },
  },
  {
    name: 'artifact_diff',
    description: 'Compare two versions of an artifact, or a version against current state. Returns unified diff format.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'Artifact slug to diff',
        },
        from: {
          type: 'string',
          description: "Starting version name (required, e.g., 'v1.0')",
        },
        to: {
          type: 'string',
          description: "Ending version name (optional - if omitted, compares against current content)",
        },
        channel: channelProperty,
      },
      required: ['slug', 'from'],
    },
  },
  // ---------------------------------------------------------------------------
  // Asset Tools
  // ---------------------------------------------------------------------------
  {
    name: 'upload_asset',
    description:
      'Upload a binary file (image, PDF, audio, video) to the channel. THIS IS THE ONLY WAY to upload images and other binary files - do NOT use artifact_create for binary assets. Provide either a local file path OR base64-encoded data. The file will be stored and served at /channels/:channelId/assets/:slug',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: "Artifact slug with file extension (e.g., 'mockup.png', 'report.pdf')",
        },
        tldr: {
          type: 'string',
          description: 'Brief description of the asset',
        },
        path: {
          type: 'string',
          description: 'Local file path (absolute or relative to cwd) - use this OR data',
        },
        data: {
          type: 'string',
          description: 'Base64-encoded file content - use this OR path (max 5MB)',
        },
        title: {
          type: 'string',
          description: 'Optional display name',
        },
        parentSlug: {
          type: 'string',
          description: 'Optional parent artifact for tree structure',
        },
        channel: channelProperty,
      },
      required: ['slug', 'tldr'],
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
  // ---------------------------------------------------------------------------
  // Instruction Tools (Phase F)
  // ---------------------------------------------------------------------------
  {
    name: 'read_instructions',
    description: buildReadInstructionsDescription(),
    inputSchema: {
      type: 'object' as const,
      properties: {
        article: {
          type: 'string',
          description: 'Article ID to read',
        },
      },
      required: ['article'],
    },
  },
];

/**
 * Build dynamic description for read_instructions tool based on loaded articles.
 */
function buildReadInstructionsDescription(): string {
  const articleList = Array.from(instructions.values())
    .map((i) => `- ${i.id}: ${i.summary}`)
    .join('\n');

  return `Read documentation for special artifact types and capabilities.

Available articles:
${articleList || '(no instructions available)'}`;
}

// =============================================================================
// Tool Handlers
// =============================================================================

interface ToolContext {
  storage: Storage;
  spaceId: string;
  channelId: string;
  callsign: string;
  assetStorage?: AssetStorage;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

const toolHandlers: Record<string, ToolHandler> = {
  // ---------------------------------------------------------------------------
  // Artifact Tools (fully implemented)
  // ---------------------------------------------------------------------------

  async artifact_create(args, { storage, channelId, callsign }) {
    const { slug, type, tldr, content, title, parentSlug, status, assignees, labels } = args as {
      slug: string;
      type: string;
      tldr: string;
      content: string;
      title?: string;
      parentSlug?: string;
      status?: string;
      assignees?: string[];
      labels?: string[];
    };

    const artifact = await storage.createArtifact(channelId, {
      slug,
      channelId,
      type: type as 'doc' | 'folder' | 'task' | 'code' | 'decision' | 'knowledgebase' | 'system.mcp' | 'system.agent' | 'system.focus' | 'system.playbook',
      title,
      tldr,
      content,
      parentSlug,
      status: status as 'draft' | 'published' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked' | undefined,
      assignees,
      labels,
      createdBy: callsign,
    });

    return JSON.stringify({
      slug: artifact.slug,
      type: artifact.type,
      path: artifact.path,
      status: artifact.status,
      version: artifact.version,
    }, null, 2);
  },

  async artifact_read(args, { storage, channelId }) {
    const { slug, channel } = args as { slug: string; channel?: string };
    const targetChannel = channel || channelId;

    const artifact = await storage.getArtifact(targetChannel, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Include version list
    const versions = await storage.listArtifactVersions(targetChannel, slug);

    return JSON.stringify({
      ...artifact,
      versions: versions.map((v) => ({
        versionName: v.versionName,
        versionMessage: v.versionMessage,
        versionCreatedBy: v.versionCreatedBy,
        versionCreatedAt: v.versionCreatedAt,
      })),
    }, null, 2);
  },

  async artifact_list(args, { storage, channelId }) {
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

    const artifacts = await storage.listArtifacts(targetChannel, {
      type: type as 'doc' | 'folder' | 'task' | 'code' | 'decision' | 'knowledgebase' | 'system.mcp' | 'system.agent' | 'system.focus' | 'system.playbook' | undefined,
      status: status as 'draft' | 'published' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked' | undefined,
      assignee,
      parentSlug: parentSlug as string | 'root' | undefined,
      search,
      limit,
      offset,
    });

    return JSON.stringify({ artifacts }, null, 2);
  },

  async artifact_glob(args, { storage, channelId }) {
    const { pattern, channel } = args as { pattern?: string; channel?: string };
    const targetChannel = channel || channelId;
    const globPattern = pattern || '/**';

    const tree = await storage.globArtifacts(targetChannel, globPattern);

    // Format as indented text for readability
    const formatTree = (nodes: typeof tree, indent = 0): string => {
      return nodes.map((node) => {
        const prefix = '  '.repeat(indent);
        const typeAnnotation = node.type !== 'doc' ? ` :${node.type}` : '';
        const statusAnnotation = node.type === 'task' ? ` (${node.status})` : '';
        const assigneeAnnotation = node.assignees.length > 0 ? ` @${node.assignees.join(', @')}` : '';
        const line = `${prefix}/${node.slug}${typeAnnotation}${statusAnnotation}${assigneeAnnotation}`;
        const children = node.children.length > 0 ? '\n' + formatTree(node.children, indent + 1) : '';
        return line + children;
      }).join('\n');
    };

    const output = formatTree(tree);
    return output || '(empty)';
  },

  async artifact_update(args, { storage, channelId, callsign }) {
    const { slug, changes, channel } = args as {
      slug: string;
      changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
      channel?: string;
    };
    const targetChannel = channel || channelId;

    // Convert from MCP format to storage format
    const storageChanges = changes.map((change) => ({
      field: change.field as 'title' | 'tldr' | 'status' | 'parentSlug' | 'orderKey' | 'assignees' | 'labels' | 'props',
      oldValue: change.oldValue,
      newValue: change.newValue,
    }));

    const result = await storage.updateArtifactWithCAS(targetChannel, slug, storageChanges, callsign);

    if (!result.success) {
      throw new Error(`Conflict on field '${result.conflict?.field}': expected ${JSON.stringify(result.conflict?.expected)} but found ${JSON.stringify(result.conflict?.actual)}`);
    }

    return JSON.stringify({
      success: true,
      slug: result.artifact?.slug,
      version: result.artifact?.version,
    }, null, 2);
  },

  async artifact_edit(args, { storage, channelId, callsign }) {
    const { slug, old_string, new_string, channel } = args as {
      slug: string;
      old_string: string;
      new_string: string;
      channel?: string;
    };
    const targetChannel = channel || channelId;

    const artifact = await storage.editArtifact(targetChannel, slug, {
      oldString: old_string,
      newString: new_string,
      updatedBy: callsign,
    });

    return JSON.stringify({
      success: true,
      slug: artifact.slug,
      version: artifact.version,
    }, null, 2);
  },

  async artifact_archive(args, { storage, channelId, callsign }) {
    const { slug, channel } = args as { slug: string; channel?: string };
    const targetChannel = channel || channelId;

    const artifact = await storage.archiveArtifact(targetChannel, slug, callsign);

    return JSON.stringify({
      archived: true,
      slug: artifact.slug,
      status: artifact.status,
    }, null, 2);
  },

  async artifact_checkpoint(args, { storage, channelId, callsign }) {
    const { slug, version, message, channel } = args as {
      slug: string;
      version: string;
      message?: string;
      channel?: string;
    };
    const targetChannel = channel || channelId;

    const artifactVersion = await storage.checkpointArtifact(targetChannel, slug, {
      versionName: version,
      versionMessage: message,
      createdBy: callsign,
    });

    return JSON.stringify({
      slug: artifactVersion.slug,
      version: artifactVersion.versionName,
      message: artifactVersion.versionMessage,
      createdBy: artifactVersion.versionCreatedBy,
      createdAt: artifactVersion.versionCreatedAt,
    }, null, 2);
  },

  async artifact_diff(args, { storage, channelId }) {
    const { slug, from, to, channel } = args as {
      slug: string;
      from: string;
      to?: string;
      channel?: string;
    };
    const targetChannel = channel || channelId;

    const diff = await storage.diffArtifactVersions(targetChannel, slug, from, to);

    return diff;
  },

  async upload_asset(args, { storage, channelId, callsign, assetStorage }) {
    const { slug, tldr, path, data, title, parentSlug, channel } = args as {
      slug: string;
      tldr: string;
      path?: string;
      data?: string;
      title?: string;
      parentSlug?: string;
      channel?: string;
    };
    const targetChannel = channel || channelId;

    if (!assetStorage) {
      throw new Error('Asset storage not configured');
    }

    // Validate: exactly one of path or data must be provided
    if (!path && !data) {
      throw new Error('Either path or data must be provided');
    }
    if (path && data) {
      throw new Error('Provide either path OR data, not both');
    }

    // Validate slug has file extension
    if (!slug.includes('.')) {
      throw new Error('Slug must include file extension (e.g., "mockup.png", "report.pdf")');
    }

    // Save asset to filesystem
    let result;
    if (path) {
      // Resolve relative paths
      const resolvedPath = path.startsWith('/') ? path : `${process.cwd()}/${path}`;

      // Verify file exists
      try {
        await fs.access(resolvedPath);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      result = await assetStorage.saveAsset({
        channelId: targetChannel,
        slug,
        source: { type: 'path', path: resolvedPath },
      });
    } else {
      // Base64 data - check size limit (5MB)
      const MAX_BASE64_SIZE = 5 * 1024 * 1024;
      const decodedSize = Math.ceil((data!.length * 3) / 4);
      if (decodedSize > MAX_BASE64_SIZE) {
        throw new Error(`Base64 data exceeds 5MB limit (${Math.round(decodedSize / 1024 / 1024)}MB). Use path-based upload for larger files.`);
      }

      result = await assetStorage.saveAsset({
        channelId: targetChannel,
        slug,
        source: { type: 'base64', data: data! },
      });
    }

    // Create artifact record
    const artifact = await storage.createArtifact(targetChannel, {
      slug,
      channelId: targetChannel,
      type: 'asset',
      title,
      tldr,
      content: '', // Assets have no text content
      parentSlug,
      contentType: result.contentType,
      fileSize: result.fileSize,
      createdBy: callsign,
    });

    return JSON.stringify({
      slug: artifact.slug,
      contentType: result.contentType,
      fileSize: result.fileSize,
      url: `/channels/${targetChannel}/assets/${slug}`,
    }, null, 2);
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

  // ---------------------------------------------------------------------------
  // Instruction Tools (Phase F)
  // ---------------------------------------------------------------------------

  async read_instructions(args) {
    const { article } = args as { article: string };

    const instruction = instructions.get(article);

    if (!instruction) {
      const availableIds = Array.from(instructions.keys()).join(', ');
      throw new Error(`Unknown article: ${article}\n\nAvailable: ${availableIds || '(none)'}`);
    }

    return instruction.content;
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
  const { storage, spaceId, assetStorage } = opts;
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
            assetStorage,
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
