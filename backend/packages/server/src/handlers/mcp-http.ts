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
  getInstructions,
  getInstruction,
  buildReadInstructionsDescription,
} from '../instructions/index.js';
import {
  parseMentions,
  determineRouting,
  tymbal,
  generateMessageId,
  getJsonSchema,
  SYSTEM_ARTIFACT_TYPES,
  type ChannelRoster,
  type RosterEntry,
} from '@cast/core';
import {
  requireContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from '../auth/container-middleware.js';
import type { ConnectionManager } from '../websocket/index.js';
import type { AgentInvoker, Message } from './messages.js';
import { broadcastArtifactEvent } from './artifacts.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format attachment slugs as text appendix for agent messages.
 * Uses [[slug]] syntax which agents recognize as artifact references.
 */
function formatAttachments(attachmentSlugs: string[] | undefined): string {
  if (!attachmentSlugs || attachmentSlugs.length === 0) {
    return '';
  }
  const slugRefs = attachmentSlugs.map((slug) => `[[${slug}]]`).join(' ');
  return `\n\n<attachments>${slugRefs}</attachments>`;
}

/**
 * Format message content for agent consumption, appending attachment info if present.
 * Works with both Message (from handlers) and StoredMessage (from storage).
 */
function formatMessageContent(msg: { content: unknown; metadata?: Record<string, unknown> }): string {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const attachmentSlugs = msg.metadata?.attachmentSlugs as string[] | undefined;
  return content + formatAttachments(attachmentSlugs);
}

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
  /** @deprecated spaceId is now extracted from container auth */
  spaceId?: string;
  /** Connection manager for broadcasting messages */
  connectionManager?: ConnectionManager;
  /** Agent invoker for routing @mentions to other agents */
  agentInvoker?: AgentInvoker;
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
          enum: ['draft', 'active', 'pending', 'in_progress', 'done', 'blocked'],
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
        props: {
          type: 'object',
          additionalProperties: true,
          description: 'Type-specific properties (e.g., MCP config, agent settings)',
        },
        channel: channelProperty,
      },
      required: ['slug', 'type', 'content'],
    },
  },
  {
    name: 'artifact_copy',
    description: 'Copy an artifact from one channel to another. Copies current content (not version history).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourceChannel: {
          type: 'string',
          description: 'Channel name or ID to copy from',
        },
        slug: {
          type: 'string',
          description: 'Slug of the artifact to copy',
        },
        targetChannel: {
          type: 'string',
          description: 'Channel name or ID to copy to (defaults to your home channel)',
        },
        newSlug: {
          type: 'string',
          description: 'New slug for the copied artifact (defaults to same slug)',
        },
        parentSlug: {
          type: 'string',
          description: 'Parent artifact slug in target channel for tree placement',
        },
      },
      required: ['sourceChannel', 'slug'],
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
  // Note: read_instructions is added dynamically in getToolsWithInstructions()
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Communication Tools (Agent UX)
  // ---------------------------------------------------------------------------
  {
    name: 'send_message',
    description: `Send a message to the channel. Use @mentions to address others:
• @callsign - notify a specific agent (e.g., "@fox can you help?")
• @channel - broadcast to all agents in this channel
Messages without @mentions are logged but won't notify anyone.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'Message content. Use @callsign or @channel to notify others.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'set_status',
    description: `Update your status to let others know what you're working on. Keep it short (a few words). Update frequently as your work progresses.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Brief status (e.g., "reviewing PR #123", "fixing auth bug", "waiting for feedback")',
        },
      },
      required: ['status'],
    },
  },
  {
    name: 'structured_ask',
    description: `Post a structured form to the channel for users to fill out. Use this when you need specific input from users in a structured format rather than free-form text.

Field types:
• radio - Single choice from options
• checkbox - Multiple choices from options  
• select - Dropdown single choice
• text - Single line text input
• textarea - Multi-line text input
• summon_request - Propose agents to summon (user can modify before submitting)
• secret - Sensitive input (API keys, passwords) that gets encrypted and stored on an artifact

The form persists in the channel until submitted. When submitted, you'll receive a follow-up message with the user's responses.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Question or context shown above the form',
        },
        fields: {
          type: 'array',
          description: 'Form fields',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['radio', 'checkbox', 'select', 'text', 'textarea', 'summon_request', 'secret'],
                description: 'Field type',
              },
              name: {
                type: 'string',
                description: 'Field identifier (used as key in response)',
              },
              label: {
                type: 'string',
                description: 'Display label for the field',
              },
              required: {
                type: 'boolean',
                description: 'Whether field is required (default: false)',
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Options for radio/checkbox/select fields',
              },
              placeholder: {
                type: 'string',
                description: 'Placeholder text for text/textarea fields',
              },
              default: {
                description: 'Default value (string for most fields, string[] for checkbox)',
              },
              agents: {
                type: 'array',
                description: 'For summon_request: proposed agents to summon',
                items: {
                  type: 'object',
                  properties: {
                    callsign: { type: 'string', description: 'Proposed callsign for the agent' },
                    definitionSlug: { type: 'string', description: 'Agent type (e.g., "nuum-production-builder")' },
                    purpose: { type: 'string', description: 'Why this agent is needed' },
                  },
                  required: ['callsign', 'definitionSlug', 'purpose'],
                },
              },
              // For secret fields: target artifact where the secret will be stored
              targetChannel: {
                type: 'string',
                description: 'For secret: channel name or ID where the target artifact lives',
              },
              targetSlug: {
                type: 'string',
                description: 'For secret: artifact slug (system.mcp or system.environment)',
              },
              targetKey: {
                type: 'string',
                description: 'For secret: key name for the secret (e.g., "OPENAI_API_KEY")',
              },
            },
            required: ['type', 'name', 'label'],
          },
        },
        submitLabel: {
          type: 'string',
          description: 'Custom submit button text (default: "Submit")',
        },
        cancelLabel: {
          type: 'string',
          description: 'Custom cancel button text (default: "Cancel")',
        },
      },
      required: ['prompt', 'fields'],
    },
  },
  // ---------------------------------------------------------------------------
  // Channel Awareness Tools
  // ---------------------------------------------------------------------------
  {
    name: 'get_roster',
    description: `Get the current channel roster with agent status and statusMessage. Returns active and paused agents (archived agents are excluded).`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_messages',
    description: `Browse channel message history with bidirectional pagination and optional filtering. Returns messages in chronological order. Use 'before' to paginate backwards (older), 'since' to paginate forwards (newer/polling). Filters compose with pagination.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max messages to return (1-100)',
        },
        before: {
          type: 'string',
          description: 'Message ID cursor - return messages older than this ID (backwards pagination)',
        },
        since: {
          type: 'string',
          description: 'Message ID cursor - return messages newer than this ID (forwards pagination / polling)',
        },
        search: {
          type: 'string',
          description: 'Keyword search - case-insensitive substring match on message content and sender',
        },
        sender: {
          type: 'string',
          description: 'Filter by sender callsign (exact match)',
        },
        includeToolCalls: {
          type: 'boolean',
          description: 'Include non-text messages like tool calls, status updates, etc. (default: false - only conversation messages with string content)',
        },
      },
      required: ['limit'],
    },
  },
  {
    name: 'list_agent_types',
    description: `List available agent definitions (system.agent artifacts) that can be spawned in this channel. Merges channel-specific definitions with root defaults (channel overrides root on slug collision).`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'explain_artifact_type',
    description: `Get documentation and JSON schema for an artifact type. Helps agents create valid artifacts by showing required fields, status values, and examples. Supports: system.agent, system.focus, system.playbook, system.mcp, doc, task, decision, code.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Artifact type to explain (e.g., "system.agent", "task", "doc")',
        },
      },
      required: ['type'],
    },
  },
  // ---------------------------------------------------------------------------
  // Knowledge Base Tools
  // ---------------------------------------------------------------------------
  {
    name: 'kb_list',
    description: 'List all active knowledge bases in the space. Returns KB channel, title, and description.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'kb_glob',
    description: 'Browse knowledge base tree structure. Returns hierarchical view of KB docs matching a glob pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kb: {
          type: 'string',
          description: 'Knowledge base channel name or ID',
        },
        pattern: {
          type: 'string',
          description: "Glob pattern (default: '/**'). Examples: '/**' (entire tree), '/api/**' (subtree), '/*' (root only)",
        },
      },
      required: ['kb'],
    },
  },
  {
    name: 'kb_read',
    description: 'Read a specific KB document by slug or path. Slugs are unique within a KB, so you can fetch by slug alone without knowing the full path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kb: {
          type: 'string',
          description: 'Knowledge base channel name or ID',
        },
        doc: {
          type: 'string',
          description: "Document slug (e.g., 'use-effect') or full path (e.g., '/hooks/use-effect')",
        },
      },
      required: ['kb', 'doc'],
    },
  },
  {
    name: 'kb_query',
    description: 'Search within a knowledge base. Supports keyword (FTS) mode. Returns matching docs with relevance scores.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kb: {
          type: 'string',
          description: 'Knowledge base channel name or ID',
        },
        query: {
          type: 'string',
          description: 'Search query',
        },
        mode: {
          type: 'string',
          enum: ['keyword', 'semantic'],
          description: "Search mode: 'keyword' (FTS, default) or 'semantic' (vector similarity - not yet implemented)",
        },
        path: {
          type: 'string',
          description: "Limit search to subtree (e.g., '/api')",
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 5, max: 50)',
        },
        highlight: {
          type: 'boolean',
          description: 'Include text snippets with highlights (default: false)',
        },
      },
      required: ['kb', 'query'],
    },
  },
];

/**
 * Get the full TOOLS array with dynamically loaded instruction description.
 */
async function getToolsWithInstructions(): Promise<McpToolDefinition[]> {
  const description = await buildReadInstructionsDescription();
  return [
    ...TOOLS,
    {
      name: 'read_instructions',
      description,
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
}

// =============================================================================
// Tool Handlers
// =============================================================================

interface ToolContext {
  storage: Storage;
  spaceId: string;
  channelId: string;
  channelName: string;
  callsign: string;
  connectionManager?: ConnectionManager;
  agentInvoker?: AgentInvoker;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

const toolHandlers: Record<string, ToolHandler> = {
  // ---------------------------------------------------------------------------
  // Artifact Tools (fully implemented)
  // ---------------------------------------------------------------------------

  async artifact_create(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { slug, type, tldr, content, title, parentSlug, status, assignees, labels, props, channel } = args as {
      slug: string;
      type: string;
      tldr: string;
      content: string;
      title?: string;
      parentSlug?: string;
      status?: string;
      assignees?: string[];
      labels?: string[];
      props?: Record<string, unknown>;
      channel?: string;
    };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifact = await storage.createArtifact(targetChannelId, {
      slug,
      channelId: targetChannelId,
      type: type as 'doc' | 'folder' | 'task' | 'code' | 'decision' | 'knowledgebase' | 'system.mcp' | 'system.agent' | 'system.focus' | 'system.playbook' | 'system.app',
      title,
      tldr,
      content,
      parentSlug,
      status: status as 'draft' | 'active' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked' | undefined,
      assignees,
      labels,
      props,
      createdBy: callsign,
    });

    // Broadcast artifact event for real-time updates
    if (connectionManager) {
      await broadcastArtifactEvent(connectionManager, targetChannelId, 'create', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });
    }

    return JSON.stringify({
      slug: artifact.slug,
      type: artifact.type,
      path: artifact.path,
      status: artifact.status,
      version: artifact.version,
    }, null, 2);
  },

  async artifact_read(args, { storage, spaceId, channelId }) {
    const { slug, channel } = args as { slug: string; channel?: string };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifact = await storage.getArtifact(targetChannelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Include version list
    const versions = await storage.listArtifactVersions(targetChannelId, slug);

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

  async artifact_list(args, { storage, spaceId, channelId }) {
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

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifacts = await storage.listArtifacts(targetChannelId, {
      type: type as 'doc' | 'folder' | 'task' | 'code' | 'decision' | 'knowledgebase' | 'system.mcp' | 'system.agent' | 'system.focus' | 'system.playbook' | 'system.app' | undefined,
      status: status as 'draft' | 'active' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked' | undefined,
      assignee,
      parentSlug: parentSlug as string | 'root' | undefined,
      search,
      limit,
      offset,
    });

    return JSON.stringify({ artifacts }, null, 2);
  },

  async artifact_glob(args, { storage, spaceId, channelId }) {
    const { pattern, channel } = args as { pattern?: string; channel?: string };
    const globPattern = pattern || '/**';

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const tree = await storage.globArtifacts(targetChannelId, globPattern);

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

  async artifact_update(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { slug, changes, channel } = args as {
      slug: string;
      changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
      channel?: string;
    };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    // Convert from MCP format to storage format
    const storageChanges = changes.map((change) => ({
      field: change.field as 'title' | 'tldr' | 'status' | 'parentSlug' | 'orderKey' | 'assignees' | 'labels' | 'props',
      oldValue: change.oldValue,
      newValue: change.newValue,
    }));

    const result = await storage.updateArtifactWithCAS(targetChannelId, slug, storageChanges, callsign);

    if (!result.success) {
      throw new Error(`Conflict on field '${result.conflict?.field}': expected ${JSON.stringify(result.conflict?.expected)} but found ${JSON.stringify(result.conflict?.actual)}`);
    }

    // Broadcast artifact event for real-time updates
    if (connectionManager && result.artifact) {
      await broadcastArtifactEvent(connectionManager, targetChannelId, 'update', {
        slug: result.artifact.slug,
        type: result.artifact.type,
        title: result.artifact.title,
        tldr: result.artifact.tldr,
        status: result.artifact.status,
      });
    }

    return JSON.stringify({
      success: true,
      slug: result.artifact?.slug,
      version: result.artifact?.version,
    }, null, 2);
  },

  async artifact_edit(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { slug, old_string, new_string, channel } = args as {
      slug: string;
      old_string: string;
      new_string: string;
      channel?: string;
    };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifact = await storage.editArtifact(targetChannelId, slug, {
      oldString: old_string,
      newString: new_string,
      updatedBy: callsign,
    });

    // Broadcast artifact event for real-time updates
    if (connectionManager) {
      await broadcastArtifactEvent(connectionManager, targetChannelId, 'update', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });
    }

    return JSON.stringify({
      success: true,
      slug: artifact.slug,
      version: artifact.version,
    }, null, 2);
  },

  async artifact_archive(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { slug, channel } = args as { slug: string; channel?: string };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifact = await storage.archiveArtifact(targetChannelId, slug, callsign);

    // Broadcast artifact event for real-time updates
    if (connectionManager) {
      await broadcastArtifactEvent(connectionManager, targetChannelId, 'archive', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });
    }

    return JSON.stringify({
      archived: true,
      slug: artifact.slug,
      status: artifact.status,
    }, null, 2);
  },

  async artifact_copy(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { sourceChannel, slug, targetChannel, newSlug, parentSlug } = args as {
      sourceChannel: string;
      slug: string;
      targetChannel?: string;
      newSlug?: string;
      parentSlug?: string;
    };

    // Resolve source channel
    const sourceResolved = await storage.resolveChannel(spaceId, sourceChannel);
    if (!sourceResolved) throw new Error(`Source channel not found: ${sourceChannel}`);

    // Resolve target channel (default to home channel)
    let targetChannelId = channelId;
    if (targetChannel) {
      const targetResolved = await storage.resolveChannel(spaceId, targetChannel);
      if (!targetResolved) throw new Error(`Target channel not found: ${targetChannel}`);
      targetChannelId = targetResolved.id;
    }

    // Fetch source artifact
    const source = await storage.getArtifact(sourceResolved.id, slug);
    if (!source) {
      throw new Error(`Artifact not found: ${slug} in channel ${sourceChannel}`);
    }

    // Create copy in target channel
    const targetSlug = newSlug || slug;
    const artifact = await storage.createArtifact(targetChannelId, {
      slug: targetSlug,
      channelId: targetChannelId,
      type: source.type as 'doc' | 'folder' | 'task' | 'code' | 'decision' | 'knowledgebase' | 'system.mcp' | 'system.agent' | 'system.focus' | 'system.playbook' | 'system.app',
      title: source.title,
      tldr: source.tldr,
      content: source.content,
      parentSlug,
      status: source.status as 'draft' | 'active' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked' | undefined,
      assignees: source.assignees,
      labels: source.labels,
      props: source.props,
      createdBy: callsign,
    });

    // Broadcast artifact event for real-time updates (in target channel)
    if (connectionManager) {
      await broadcastArtifactEvent(connectionManager, targetChannelId, 'create', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });
    }

    return JSON.stringify({
      copied: true,
      sourceChannel,
      sourceSlug: slug,
      targetSlug: artifact.slug,
      path: artifact.path,
    }, null, 2);
  },

  async artifact_checkpoint(args, { storage, spaceId, channelId, callsign }) {
    const { slug, version, message, channel } = args as {
      slug: string;
      version: string;
      message?: string;
      channel?: string;
    };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const artifactVersion = await storage.checkpointArtifact(targetChannelId, slug, {
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

  async artifact_diff(args, { storage, spaceId, channelId }) {
    const { slug, from, to, channel } = args as {
      slug: string;
      from: string;
      to?: string;
      channel?: string;
    };

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const diff = await storage.diffArtifactVersions(targetChannelId, slug, from, to);

    return diff;
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

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const msgLimit = limit ?? 50;

    const messages = await storage.getMessages(spaceId, targetChannelId, {
      limit: msgLimit,
      before,
      since,
    });

    const formatted = messages.map((msg) => ({
      id: msg.id,
      sender: msg.sender,
      senderType: msg.senderType,
      timestamp: msg.timestamp,
      content: formatMessageContent(msg),
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

    // Resolve channel name to ID
    let targetChannelId = channelId;
    if (channel) {
      const resolved = await storage.resolveChannel(spaceId, channel);
      if (!resolved) throw new Error(`Channel not found: ${channel}`);
      targetChannelId = resolved.id;
    }

    const msgLimit = limit ?? 100;

    // Fetch more messages to filter client-side
    const fetchLimit = Math.min(msgLimit * 3, 500);
    let messages = await storage.getMessages(spaceId, targetChannelId, { limit: fetchLimit });

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
      content: formatMessageContent(msg),
    }));

    return JSON.stringify({ count: formatted.length, messages: formatted }, null, 2);
  },

  // ---------------------------------------------------------------------------
  // Instruction Tools (Phase F)
  // ---------------------------------------------------------------------------

  async read_instructions(args) {
    const { article } = args as { article: string };

    const instruction = await getInstruction(article);

    if (!instruction) {
      const instructions = await getInstructions();
      const availableIds = Array.from(instructions.keys()).join(', ');
      throw new Error(`Unknown article: ${article}\n\nAvailable: ${availableIds || '(none)'}`);
    }

    return instruction.content;
  },

  // ---------------------------------------------------------------------------
  // Communication Tools (Agent UX)
  // ---------------------------------------------------------------------------

  async send_message(args, { storage, spaceId, channelId, callsign, connectionManager, agentInvoker }) {
    const { content } = args as { content: string };

    if (!content || typeof content !== 'string') {
      throw new Error('content is required and must be a string');
    }

    // Get roster for routing (including human users for valid @mentions)
    const rosterEntries = await storage.listRoster(channelId);
    const leaderEntry = rosterEntries.find((e: RosterEntry) => e.agentType.toLowerCase().includes('lead'));

    // Get space owner's callsign (human user)
    const space = await storage.getSpace(spaceId);
    const owner = space ? await storage.getUser(space.ownerId) : null;

    const roster: ChannelRoster = {
      agents: rosterEntries.map((e: RosterEntry) => e.callsign),
      leader: leaderEntry?.callsign ?? rosterEntries[0]?.callsign ?? '',
      users: owner?.callsign ? [owner.callsign] : [],
    };

    // Parse @mentions and determine routing targets
    const parsed = parseMentions(content);
    // Agent messages: senderIsHuman = false
    const routing = determineRouting(parsed, false, roster, callsign);

    const messageId = generateMessageId();
    const now = new Date().toISOString();

    // Save message with method: 'send_message' in metadata
    await storage.saveMessage({
      id: messageId,
      spaceId,
      channelId,
      sender: callsign,
      senderType: 'agent',
      type: 'agent',
      content,
      isComplete: true,
      addressedAgents: routing.targets.length > 0 ? routing.targets : undefined,
      metadata: { method: 'send_message' },
    });

    // Broadcast to WebSocket clients
    if (connectionManager) {
      const frame = tymbal.set(messageId, {
        type: 'agent',
        sender: callsign,
        senderType: 'agent',
        content,
        timestamp: now,
        method: 'send_message',
        ...(routing.targets.length > 0 ? { mentions: routing.targets } : {}),
        ...(routing.isBroadcast ? { broadcast: true } : {}),
      });
      await connectionManager.broadcast(channelId, frame);
    }

    // Invoke mentioned agents (filter out human users - they're valid targets but not agents to invoke)
    const agentTargets = routing.targets.filter((t) => !roster.users?.includes(t));
    if (agentInvoker && agentTargets.length > 0) {
      const message: Message = {
        id: messageId,
        channelId,
        sender: callsign,
        senderType: 'agent',
        type: 'agent',
        content,
        timestamp: now,
        isComplete: true,
        addressedAgents: agentTargets,
      };
      await agentInvoker.invokeAgents(channelId, agentTargets, message);
    }

    const response: Record<string, unknown> = {
      id: messageId,
      timestamp: now,
      delivered: routing.targets,
    };

    // Add hint when no agents were notified
    if (routing.targets.length === 0) {
      response.hint = 'No @mentions — message logged but no agents notified.';
    }

    return JSON.stringify(response, null, 2);
  },

  async set_status(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { status } = args as { status: string };

    if (!status || typeof status !== 'string') {
      throw new Error('status is required and must be a string');
    }

    // Find roster entry to update current.status field
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    if (rosterEntry) {
      // Update roster entry's ephemeral current state with status text
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        current: { status },
      });
    }

    const now = new Date().toISOString();

    // Broadcast status frame via Tymbal (NOT a message frame - different frame type)
    // Status uses the "→ status" format in UI
    if (connectionManager) {
      // Generate a unique ID for the status update
      const statusId = generateMessageId();

      // Status is broadcast as a special frame type that the frontend handles differently
      // Using tymbal.set with type: 'status' and simple content
      const frame = tymbal.set(statusId, {
        type: 'status',
        sender: callsign,
        senderType: 'agent',
        content: { status },
        timestamp: now,
      });
      await connectionManager.broadcast(channelId, frame);

      // Also save to storage so it persists (shown as → status in chat)
      await storage.saveMessage({
        id: statusId,
        spaceId,
        channelId,
        sender: callsign,
        senderType: 'agent',
        type: 'status',
        content: { status },
        isComplete: true,
        metadata: { method: 'set_status' },
      });
    }

    return JSON.stringify({
      status,
      timestamp: now,
    }, null, 2);
  },

  async structured_ask(args, { storage, spaceId, channelId, callsign, connectionManager }) {
    const { prompt, fields, submitLabel, cancelLabel } = args as {
      prompt: string;
      fields: Array<{
        type: 'radio' | 'checkbox' | 'select' | 'text' | 'textarea' | 'summon_request' | 'secret';
        name: string;
        label: string;
        required?: boolean;
        options?: string[];
        placeholder?: string;
        default?: string | string[];
        agents?: Array<{
          callsign: string;
          definitionSlug: string;
          purpose: string;
        }>;
        // For secret fields
        targetChannel?: string;
        targetSlug?: string;
        targetKey?: string;
      }>;
      submitLabel?: string;
      cancelLabel?: string;
    };

    if (!prompt || typeof prompt !== 'string') {
      throw new Error('prompt is required and must be a string');
    }

    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      throw new Error('fields is required and must be a non-empty array');
    }

    // Validate fields
    for (const field of fields) {
      if (!field.type || !field.name || !field.label) {
        throw new Error('Each field must have type, name, and label');
      }

      const validTypes = ['radio', 'checkbox', 'select', 'text', 'textarea', 'summon_request', 'secret'];
      if (!validTypes.includes(field.type)) {
        throw new Error(`Invalid field type: ${field.type}. Must be one of: ${validTypes.join(', ')}`);
      }

      // Validate options for choice fields
      if (['radio', 'checkbox', 'select'].includes(field.type)) {
        if (!field.options || !Array.isArray(field.options) || field.options.length === 0) {
          throw new Error(`Field "${field.name}" of type "${field.type}" requires non-empty options array`);
        }
      }

      // Validate agents for summon_request
      if (field.type === 'summon_request') {
        if (!field.agents || !Array.isArray(field.agents) || field.agents.length === 0) {
          throw new Error(`Field "${field.name}" of type "summon_request" requires non-empty agents array`);
        }
        for (const agent of field.agents) {
          if (!agent.callsign || !agent.definitionSlug || !agent.purpose) {
            throw new Error('Each agent in summon_request must have callsign, definitionSlug, and purpose');
          }
        }
        // Check for callsign collisions with existing roster
        for (const agent of field.agents) {
          const existing = await storage.getRosterByCallsign(channelId, agent.callsign);
          if (existing) {
            throw new Error(`Callsign "${agent.callsign}" already exists in this channel's roster. Choose a different callsign.`);
          }
        }
      }

      // Validate target for secret fields
      if (field.type === 'secret') {
        if (!field.targetChannel || !field.targetSlug || !field.targetKey) {
          throw new Error(`Field "${field.name}" of type "secret" requires targetChannel, targetSlug, and targetKey`);
        }
      }
    }

    const messageId = generateMessageId();
    const now = new Date().toISOString();

    // Build the structured ask content
    const content = {
      prompt,
      fields,
      submitLabel: submitLabel || 'Submit',
      cancelLabel: cancelLabel || 'Cancel',
      formState: 'pending' as const,
    };

    // Save as a structured_ask message
    await storage.saveMessage({
      id: messageId,
      spaceId,
      channelId,
      sender: callsign,
      senderType: 'agent',
      type: 'structured_ask',
      content,
      isComplete: true,
      metadata: { method: 'structured_ask' },
      state: 'pending',
    });

    // Broadcast to WebSocket clients
    if (connectionManager) {
      const frame = tymbal.set(messageId, {
        type: 'structured_ask',
        sender: callsign,
        senderType: 'agent',
        content,
        timestamp: now,
        method: 'structured_ask',
        state: 'pending',
      });
      await connectionManager.broadcast(channelId, frame);
    }

    return JSON.stringify({
      id: messageId,
      timestamp: now,
      prompt,
      fieldCount: fields.length,
      hint: 'Form posted to channel. You will receive a message when the user submits their response.',
    }, null, 2);
  },

  // ---------------------------------------------------------------------------
  // Channel Awareness Tools
  // ---------------------------------------------------------------------------

  async get_roster(_args, { storage, spaceId, channelId, channelName }) {
    // Get all roster entries for this channel
    const rosterEntries = await storage.listRoster(channelId);

    // Filter out archived agents (they're "out of the story")
    const activeRoster = rosterEntries.filter(
      (entry: RosterEntry) => entry.status !== 'archived'
    );

    // Map to response format
    const agents = activeRoster.map((entry: RosterEntry) => {
      // Map roster status to simplified active/paused
      // active, idle, busy, offline -> "active" (they're in the channel)
      // paused -> "paused"
      const status = entry.status === 'paused' ? 'paused' : 'active';

      const agent: Record<string, unknown> = {
        callsign: entry.callsign,
        agentType: entry.agentType,
        title: entry.agentType.charAt(0).toUpperCase() + entry.agentType.slice(1), // Capitalize as fallback
        status,
      };

      // Add statusMessage if present
      if (entry.current?.status) {
        agent.statusMessage = entry.current.status;
      }

      return agent;
    });

    // Get space owner (human user) and add to roster
    const space = await storage.getSpace(spaceId);
    const owner = space ? await storage.getUser(space.ownerId) : null;

    // Build members list: user first, then agents
    const members: Array<Record<string, unknown>> = [];

    if (owner?.callsign) {
      members.push({
        callsign: owner.callsign,
        type: 'user',
        title: 'User',
      });
    }

    // Add agents with type: 'agent'
    for (const agent of agents) {
      members.push({
        ...agent,
        type: 'agent',
      });
    }

    // Build hint
    const activeCount = agents.filter((a) => a.status === 'active').length;
    const pausedCount = agents.filter((a) => a.status === 'paused').length;

    let hint = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
    if (activeCount > 0 || pausedCount > 0) {
      const parts = [];
      if (activeCount > 0) parts.push(`${activeCount} active`);
      if (pausedCount > 0) parts.push(`${pausedCount} paused`);
      hint += ` (${parts.join(', ')})`;
    }

    // Add status messages to hint
    const withStatus = agents.filter((a) => a.statusMessage);
    if (withStatus.length > 0) {
      const statusParts = withStatus.map((a) => `@${a.callsign}: ${a.statusMessage}`);
      hint += `. ${statusParts.join('; ')}.`;
    }

    return JSON.stringify({
      channel: channelName,
      members,
      agents, // Keep for backwards compatibility
      hint,
    }, null, 2);
  },

  async get_messages(args, { storage, spaceId, channelId, channelName }) {
    const { limit: requestedLimit, before, since, search, sender, includeToolCalls } = args as {
      limit?: number;
      before?: string;
      since?: string;
      search?: string;
      sender?: string;
      includeToolCalls?: boolean;
    };

    // Validate: limit is required
    if (requestedLimit === undefined || requestedLimit === null) {
      return JSON.stringify({
        error: 'invalid_params',
        message: "Missing required parameter 'limit'",
        hint: 'Specify limit (1-100) to control how many messages to fetch',
      }, null, 2);
    }

    // Validate: before and since are mutually exclusive
    if (before && since) {
      return JSON.stringify({
        error: 'invalid_params',
        message: "Cannot use both 'before' and 'since' — pick one direction",
        hint: "Use 'before' to paginate backwards (older), 'since' to paginate forwards (newer)",
      }, null, 2);
    }

    // Validate and cap limit
    const limit = Math.min(Math.max(requestedLimit, 1), 100);

    // Fetch messages with appropriate cursor and filters
    // - No cursor: fetch newest messages (initial load)
    // - before: fetch older messages (backwards pagination)
    // - since: fetch newer messages (forwards pagination / polling)
    const messages = await storage.getMessages(spaceId, channelId, {
      limit: limit + 1, // Fetch one extra to determine hasMore
      before,
      since,
      newestFirst: !before && !since, // Only use newestFirst when no cursor
      search,
      sender,
      includeToolCalls,
    });

    // Filter out status messages (ephemeral, not conversation content)
    const conversationMessages = messages.filter(
      (msg) => msg.type !== 'status'
    );

    // Determine pagination indicators and trim to requested limit
    // When using 'since', hasMore means there are newer messages (hasNewer)
    // When using 'before' or no cursor, hasMore means there are older messages (hasOlder)
    const hasMore = conversationMessages.length > limit;
    const resultMessages = hasMore
      ? conversationMessages.slice(0, limit)
      : conversationMessages;

    // Map to response format with senderType
    // Storage uses 'user' but spec says 'human' for consistency
    const formatted = resultMessages.map((msg) => ({
      id: msg.id,
      sender: msg.sender,
      senderType: msg.senderType === 'user' ? 'human' : msg.senderType,
      content: formatMessageContent(msg),
      timestamp: msg.timestamp,
    }));

    // Get cursor IDs for pagination
    const oldestId = formatted.length > 0 ? formatted[0].id : undefined;
    const newestId = formatted.length > 0 ? formatted[formatted.length - 1].id : undefined;

    // Check if filters are active
    const hasFilters = search || sender;

    // Build response based on query direction
    const response: Record<string, unknown> = {
      channel: channelName,
      messages: formatted,
    };

    // Echo filters back so agents know what they searched for
    if (hasFilters) {
      response.filters = {
        search: search || null,
        sender: sender || null,
      };
    }

    // Build hint and pagination indicators based on direction
    let hint = `${formatted.length} message${formatted.length !== 1 ? 's' : ''}`;

    // Add filter context to hint
    if (search && sender) {
      hint += ` matching '${search}' from @${sender}`;
    } else if (search) {
      hint += ` matching '${search}'`;
    } else if (sender) {
      hint += ` from @${sender}`;
    } else {
      hint += ' (chronological)';
    }

    if (since) {
      // Forward pagination mode (polling for new)
      response.hasNewer = hasMore;
      response.newestId = newestId;
      if (hasMore) {
        hint += `. More ${hasFilters ? 'matches' : 'new messages'} — use since: '${newestId}' to continue.`;
      }
    } else {
      // Backward pagination mode (history browsing) or initial load
      response.hasOlder = hasMore;
      response.oldestId = oldestId;
      response.newestId = newestId;
      if (hasMore) {
        hint += `. Older ${hasFilters ? 'matches' : 'history'} available — use before: '${oldestId}' to paginate backwards.`;
      }
    }

    response.hint = hint;

    return JSON.stringify(response, null, 2);
  },

  async list_agent_types(_args, { storage, spaceId, channelId, channelName }) {
    // Get system.agent artifacts from current channel
    const channelAgents = await storage.listArtifacts(channelId, {
      type: 'system.agent',
    });

    // Get root channel to fetch global agent definitions
    const rootChannel = await storage.getChannelByName(spaceId, 'root');
    let rootAgents: typeof channelAgents = [];
    if (rootChannel) {
      rootAgents = await storage.listArtifacts(rootChannel.id, {
        type: 'system.agent',
      });
    }

    // Merge: channel overrides root (same slug)
    const agentMap = new Map<string, { artifact: typeof channelAgents[0]; source: 'channel' | 'root' }>();

    // Add root agents first
    for (const agent of rootAgents) {
      agentMap.set(agent.slug, { artifact: agent, source: 'root' });
    }

    // Channel agents override root
    for (const agent of channelAgents) {
      agentMap.set(agent.slug, { artifact: agent, source: 'channel' });
    }

    // Build response
    const agentTypes = Array.from(agentMap.values()).map(({ artifact, source }) => {
      const entry: Record<string, unknown> = {
        slug: artifact.slug,
        title: artifact.title || artifact.slug.charAt(0).toUpperCase() + artifact.slug.slice(1),
        tldr: artifact.tldr || '',
        source,
      };

      // Include engine from props if present
      if (artifact.props?.engine) {
        entry.engine = artifact.props.engine;
      }

      return entry;
    });

    // Build hint
    const channelCount = Array.from(agentMap.values()).filter(({ source }) => source === 'channel').length;
    const rootCount = agentTypes.length - channelCount;

    let hint = `${agentTypes.length} agent type${agentTypes.length !== 1 ? 's' : ''} available`;
    if (channelCount > 0 || rootCount > 0) {
      const parts = [];
      if (channelCount > 0) parts.push(`${channelCount} from channel`);
      if (rootCount > 0) parts.push(`${rootCount} from root`);
      hint += ` (${parts.join(', ')})`;
    }

    return JSON.stringify({
      channel: channelName,
      agentTypes,
      hint,
    }, null, 2);
  },

  async explain_artifact_type(args) {
    const { type } = args as { type: string };

    // Artifact type metadata registry (descriptions, status values, examples, hints)
    // Props schemas come from @cast/core via getJsonSchema()
    const typeMetadata: Record<string, {
      description: string;
      statusValues: string[];
      example?: object;
      hint: string;
    }> = {
      // System types (props schemas from @cast/core)
      'system.agent': {
        description: 'Agent definition specifying AI engine, model, and capabilities. Agents are spawned from these definitions when added to a channel roster.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'engineer',
          type: 'system.agent',
          tldr: 'Full-stack engineer agent',
          props: { engine: 'claude', model: 'claude-sonnet-4-20250514', nameTheme: 'animals' },
        },
        hint: 'Define in #root channel for global availability, or in specific channel for local override.',
      },

      'system.focus': {
        description: 'Channel template defining default agents and initial setup. When a channel is created with this focus, the specified agents are automatically spawned.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'code-review',
          type: 'system.focus',
          tldr: 'Code review workflow with reviewer and engineer',
          props: { agents: ['reviewer', 'engineer'], defaultTagline: 'Code review session' },
        },
        hint: 'Create in #root to make available as channel template. Agents array references system.agent slugs.',
      },

      'system.mcp': {
        description: 'MCP server configuration for stdio or HTTP transports. Referenced by system.agent to provide tools to agents.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'github-mcp',
          type: 'system.mcp',
          tldr: 'GitHub API integration via MCP',
          props: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
        hint: 'Reference from system.agent via mcp array. Use ${VAR} in env/headers for server-side variable expansion.',
      },

      'system.playbook': {
        description: 'Workflow guidelines and conventions for a channel. Agents should read playbooks when joining to understand how work is done.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'git-workflow',
          type: 'system.playbook',
          tldr: 'Git branching and commit conventions',
          content: '## Branch Naming\n- feature/TICKET-description\n- fix/TICKET-description\n\n## Commits\nUse conventional commits...',
        },
        hint: 'Agents should read playbooks when joining a channel to understand conventions.',
      },

      // Standard content types (no props schemas)
      'doc': {
        description: 'General documentation: specs, plans, notes, READMEs. The default artifact type for most content.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'api-spec',
          type: 'doc',
          tldr: 'REST API specification for user service',
          content: '# User API\n\n## Endpoints\n\n### GET /users...',
        },
        hint: 'Default type for specs, plans, and general documentation. Use parentSlug for tree organization.',
      },

      'task': {
        description: 'Work items with status tracking. Use for actionable items that need to be completed. Supports assignees.',
        statusValues: ['pending', 'in_progress', 'done', 'blocked'],
        example: {
          slug: 'implement-auth',
          type: 'task',
          status: 'pending',
          tldr: 'Implement JWT authentication for API',
          assignees: ['fox'],
          content: '## Requirements\n- Token expiry: 24h\n- Refresh tokens...',
        },
        hint: 'Use update tool with compare-and-swap to claim tasks atomically and prevent race conditions.',
      },

      'decision': {
        description: 'Logged choices with rationale. Use to document architectural decisions, tradeoffs considered, and why a path was chosen.',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'use-postgres',
          type: 'decision',
          tldr: 'Chose PostgreSQL over MongoDB for relational data needs',
          content: '## Context\nNeed a database for user data with complex relations...\n\n## Decision\nPostgreSQL\n\n## Rationale\n...',
        },
        hint: 'Document the context, options considered, and rationale. Helps future contributors understand why.',
      },

      'code': {
        description: 'Code snippets and file references. Slug should include file extension for syntax highlighting (e.g., auth.ts, config.json).',
        statusValues: ['draft', 'active', 'archived'],
        example: {
          slug: 'auth-middleware.ts',
          type: 'code',
          tldr: 'JWT validation middleware for Express',
          content: 'import jwt from "jsonwebtoken";\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1];\n  // ...\n}',
        },
        hint: 'Use file extension in slug (e.g., foo.ts) for syntax highlighting. Content is raw code, not markdown.',
      },
    };

    const metadata = typeMetadata[type];
    if (!metadata) {
      const knownTypes = Object.keys(typeMetadata).join(', ');
      return JSON.stringify({
        error: 'unknown_type',
        message: `Unknown artifact type: "${type}"`,
        hint: `Supported types: ${knownTypes}`,
      }, null, 2);
    }

    const response: Record<string, unknown> = {
      type,
      description: metadata.description,
      statusValues: metadata.statusValues,
    };

    // Get props schema from @cast/core for system types
    const propsSchema = getJsonSchema(type);
    if (propsSchema) {
      response.propsSchema = propsSchema;
    }

    if (metadata.example) {
      response.example = metadata.example;
    }

    response.hint = metadata.hint;

    return JSON.stringify(response, null, 2);
  },

  // ---------------------------------------------------------------------------
  // Knowledge Base Tools
  // ---------------------------------------------------------------------------

  async kb_list(_args, { storage, spaceId }) {
    // Single JOIN query - no N+1 channel loop
    const knowledgeBases = await storage.listPublishedKnowledgeBases(spaceId);

    const hint = knowledgeBases.length === 0
      ? 'No active knowledge bases found in this space.'
      : `${knowledgeBases.length} knowledge base${knowledgeBases.length !== 1 ? 's' : ''} available.`;

    return JSON.stringify({ knowledgeBases, hint }, null, 2);
  },

  async kb_glob(args, { storage, spaceId }) {
    const { kb, pattern } = args as { kb: string; pattern?: string };

    // Resolve KB channel
    const channel = await storage.resolveChannel(spaceId, kb);
    if (!channel) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }

    // Check KB exists and is active (support legacy 'published' status)
    const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
    if (!kbRoot) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }
    if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
      throw new Error(`Knowledge base is not active: ${kb}`);
    }

    // Get KB tree
    const globPattern = pattern || '/**';
    const kbPattern = globPattern.startsWith('/')
      ? `/knowledgebase${globPattern}`
      : `/knowledgebase/${globPattern}`;

    const fullTree = await storage.globArtifacts(channel.id, kbPattern);

    // Filter to only active docs (support legacy 'published' status) and format as text tree
    type TreeNode = { slug: string; path: string; title?: string; tldr?: string; status: string; type: string; children: TreeNode[] };

    const formatTree = (nodes: TreeNode[], indent = 0): string => {
      return nodes
        .filter((node) => node.status === 'active' || node.status === 'published')
        .map((node) => {
          const prefix = '  '.repeat(indent);
          const title = node.title || node.slug;
          const tldr = node.tldr ? ` - ${node.tldr}` : '';
          const line = `${prefix}${node.slug}${tldr}`;
          const children = formatTree(node.children as TreeNode[], indent + 1);
          return children ? `${line}\n${children}` : line;
        })
        .join('\n');
    };

    // The tree from glob includes the KB root - we want children only
    const kbTree = fullTree.length > 0 && fullTree[0].slug === 'knowledgebase'
      ? fullTree[0].children
      : fullTree;

    const output = formatTree(kbTree as TreeNode[]);
    return output || '(empty)';
  },

  async kb_read(args, { storage, spaceId }) {
    const { kb, doc } = args as { kb: string; doc: string };

    // Resolve KB channel
    const channel = await storage.resolveChannel(spaceId, kb);
    if (!channel) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }

    // Check KB exists and is active (support legacy 'published' status)
    const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
    if (!kbRoot) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }
    if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
      throw new Error(`Knowledge base is not active: ${kb}`);
    }

    // Try to find doc by slug first
    let artifact = await storage.getArtifact(channel.id, doc);

    // If not found, try path lookup
    if (!artifact) {
      // doc might be a path like "/hooks/use-effect" or "hooks/use-effect"
      const pathParts = doc.replace(/^\//, '').split('/');
      const artifacts = await storage.listArtifacts(channel.id, {
        search: pathParts[pathParts.length - 1], // Search by last segment
      });

      // Find one where path ends with the doc segments
      const match = artifacts.find((a) => {
        const aPathParts = a.path.replace(/^knowledgebase\.?/, '').split('.');
        if (aPathParts.length < pathParts.length) return false;
        const tail = aPathParts.slice(-pathParts.length);
        return pathParts.every(
          (seg, i) => seg.replace(/-/g, '_') === tail[i]
        );
      });

      if (match) {
        artifact = await storage.getArtifact(channel.id, match.slug);
      }
    }

    if (!artifact) {
      throw new Error(`Document not found: ${doc}`);
    }

    // Verify it's an active doc under KB (support legacy 'published' status)
    if (artifact.status !== 'active' && artifact.status !== 'published') {
      throw new Error(`Document not found: ${doc}`);
    }

    if (!artifact.path.startsWith('knowledgebase')) {
      throw new Error(`Document not found: ${doc}`);
    }

    // Convert path to KB-relative format
    const kbPath = '/' + artifact.path.replace(/^knowledgebase\.?/, '').replace(/\./g, '/');

    return JSON.stringify({
      name: channel.name,
      path: kbPath || '/',
      slug: artifact.slug,
      title: artifact.title,
      tldr: artifact.tldr,
      content: artifact.content,
      refs: artifact.refs,
    }, null, 2);
  },

  async kb_query(args, { storage, spaceId }) {
    const { kb, query, mode, path: pathFilter, limit: limitParam, highlight } = args as {
      kb: string;
      query: string;
      mode?: string;
      path?: string;
      limit?: number;
      highlight?: boolean;
    };

    // Resolve KB channel
    const channel = await storage.resolveChannel(spaceId, kb);
    if (!channel) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }

    // Check KB exists and is active (support legacy 'published' status)
    const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
    if (!kbRoot) {
      throw new Error(`Knowledge base not found: ${kb}`);
    }
    if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
      throw new Error(`Knowledge base is not active: ${kb}`);
    }

    // Semantic mode not implemented
    if (mode === 'semantic') {
      return JSON.stringify({
        error: 'not_implemented',
        message: 'Semantic search is not yet implemented. Use mode=keyword.',
      }, null, 2);
    }

    const limit = Math.min(Math.max(limitParam || 5, 1), 50);

    // Use FTS search with KB path filter (no status filter - we'll filter after for both 'active' and legacy 'published')
    const searchResults = await storage.listArtifacts(channel.id, {
      search: query,
      limit: limit * 3, // Fetch extra to filter by path and status
    });

    // Filter to active KB docs only (support legacy 'published' status)
    let kbResults = searchResults.filter(
      (a) => a.path.startsWith('knowledgebase') && a.type === 'doc' &&
        (a.status === 'active' || a.status === 'published')
    );

    // Apply path filter if specified
    if (pathFilter) {
      const ltreePrefix =
        'knowledgebase' +
        (pathFilter === '/' ? '' : '.' + pathFilter.slice(1).replace(/\//g, '.').replace(/-/g, '_'));
      kbResults = kbResults.filter((a) => a.path.startsWith(ltreePrefix));
    }

    // Limit results
    kbResults = kbResults.slice(0, limit);

    // Format results
    const results = await Promise.all(
      kbResults.map(async (a) => {
        const kbPath =
          '/' + a.path.replace(/^knowledgebase\.?/, '').replace(/\./g, '/');

        const result: {
          path: string;
          slug: string;
          title?: string;
          tldr?: string;
          snippet?: string;
        } = {
          path: kbPath || '/',
          slug: a.slug,
          title: a.title,
          tldr: a.tldr,
        };

        // Get snippet if requested
        if (highlight) {
          const fullArtifact = await storage.getArtifact(channel.id, a.slug);
          if (fullArtifact?.content) {
            const content = fullArtifact.content;
            const queryLower = query.toLowerCase();
            const contentLower = content.toLowerCase();
            const idx = contentLower.indexOf(queryLower);
            if (idx !== -1) {
              const start = Math.max(0, idx - 50);
              const end = Math.min(content.length, idx + query.length + 50);
              let snippet = content.slice(start, end);
              if (start > 0) snippet = '...' + snippet;
              if (end < content.length) snippet = snippet + '...';
              const matchStart = idx - start;
              const matchEnd = matchStart + query.length;
              snippet =
                snippet.slice(0, matchStart) +
                '<mark>' +
                snippet.slice(matchStart, matchEnd) +
                '</mark>' +
                snippet.slice(matchEnd);
              result.snippet = snippet;
            }
          }
        }

        return result;
      })
    );

    return JSON.stringify({
      name: channel.name,
      query,
      mode: mode || 'keyword',
      results,
      total: results.length,
    }, null, 2);
  },
};

// =============================================================================
// Route Factory
// =============================================================================

/**
 * Resolve channel by name first, then by ID.
 * This allows agents to use friendly channel names in URLs.
 */
async function resolveChannelHelper(storage: Storage, spaceId: string, channelIdOrName: string) {
  // Single query that handles both ID and name lookup
  return storage.resolveChannel(spaceId, channelIdOrName);
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
  const { storage, connectionManager, agentInvoker } = opts;
  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Apply container auth to all MCP routes
  app.use('*', requireContainerAuth());

  // POST /mcp/:channel - Single JSON-RPC endpoint
  app.post('/:channel', async (c) => {
    const channelIdOrName = c.req.param('channel');
    const container = getContainerAuth(c);
    const spaceId = container.spaceId;

    // Resolve channel by name or ID
    const channel = await resolveChannelHelper(storage, spaceId, channelIdOrName);
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
        const tools = await getToolsWithInstructions();
        return c.json(jsonRpcSuccess(request.id, { tools }));
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
            channelName: channel.name,
            callsign: container.callsign,
            connectionManager,
            agentInvoker,
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
