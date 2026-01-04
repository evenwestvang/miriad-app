/**
 * MCP Cikada Tools Server
 *
 * Provides artifact and message tools that wrap Cikada's HTTP API.
 *
 * Artifact tools: create, read, list, glob, update, edit, archive
 * Message tools: get, search, context
 *
 * Configuration via environment:
 * - CIKADA_API_URL - Base URL (e.g., http://localhost:3001)
 * - CIKADA_CHANNEL_ID - Channel ID for the agent's context
 * - CIKADA_CALLSIGN - Agent's callsign (used as createdBy/updatedBy)
 *
 * All tools accept an optional `channel` parameter to override the default channel.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Configuration from environment
const CIKADA_API_URL = process.env.CIKADA_API_URL ?? "";
const CIKADA_CHANNEL_ID = process.env.CIKADA_CHANNEL_ID ?? "";
const CIKADA_CALLSIGN = process.env.CIKADA_CALLSIGN ?? "";
const CIKADA_SPACE_ID = process.env.CIKADA_SPACE_ID ?? "";
const CIKADA_AUTH_TOKEN = process.env.CIKADA_AUTH_TOKEN ?? "";

const isConfigured = CIKADA_API_URL && CIKADA_CHANNEL_ID && CIKADA_CALLSIGN;

// =============================================================================
// HTTP Client
// =============================================================================

interface HttpResponse {
  ok: boolean;
  status: number;
  data: any;
}

async function httpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<HttpResponse> {
  const url = `${CIKADA_API_URL}${path}`;

  // Build headers - include auth token for container authentication
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (CIKADA_AUTH_TOKEN) {
    headers["X-Cikada-Token"] = CIKADA_AUTH_TOKEN;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

// Helper to get channel ID (supports optional override for cross-channel access)
function getChannelId(channelOverride?: string): string {
  return channelOverride ?? CIKADA_CHANNEL_ID;
}

// =============================================================================
// MIME Type Detection & Multipart Helpers
// =============================================================================

// Extension to MIME type mapping (must match server's ATTACHMENT_ALLOWED_TYPES)
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".pdf": "application/pdf",
};

function getMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? null;
}

/**
 * Create multipart/form-data body for file upload
 */
interface MultipartBodyOptions {
  filename: string;
  fileData: Buffer;
  mimeType: string;
  uploadedBy: string;
  title?: string;
  description?: string;
  messageId?: string;
  customFilename?: string;
}

function createMultipartBody(options: MultipartBodyOptions): { body: Buffer; boundary: string } {
  const { filename, fileData, mimeType, uploadedBy, title, description, messageId, customFilename } = options;
  const boundary = "----CikadaBoundary" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];

  // Add uploadedBy field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="uploadedBy"\r\n\r\n` +
    `${uploadedBy}\r\n`
  ));

  // Add messageId field if provided (for linking attachment to additional message)
  if (messageId) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="messageId"\r\n\r\n` +
      `${messageId}\r\n`
    ));
  }

  // Add title field if provided
  if (title) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="title"\r\n\r\n` +
      `${title}\r\n`
    ));
  }

  // Add description field if provided
  if (description) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="description"\r\n\r\n` +
      `${description}\r\n`
    ));
  }

  // Add custom filename field if provided (different from multipart filename)
  if (customFilename) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="filename"\r\n\r\n` +
      `${customFilename}\r\n`
    ));
  }

  // Add file
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

// =============================================================================
// Tool Implementations
// =============================================================================

interface ArtifactCreateParams {
  slug: string;
  type: string;
  tldr: string;
  content: string;
  title?: string;
  parentSlug?: string;
  status?: string;
  assignees?: string[];
  labels?: string[];
  channel?: string;
}

async function artifactCreate(params: ArtifactCreateParams): Promise<string> {
  const { channel, ...rest } = params;
  const channelId = getChannelId(channel);

  const response = await httpRequest(
    "POST",
    `/channels/${channelId}/artifacts`,
    {
      ...rest,
      createdBy: CIKADA_CALLSIGN,
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to create artifact: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

interface ArtifactReadParams {
  slug: string;
  channel?: string;
}

async function artifactRead(params: ArtifactReadParams): Promise<string> {
  const channelId = getChannelId(params.channel);

  const response = await httpRequest(
    "GET",
    `/channels/${channelId}/artifacts/${encodeURIComponent(params.slug)}`
  );

  if (!response.ok) {
    throw new Error(`Failed to read artifact: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

interface ArtifactListParams {
  type?: string;
  status?: string;
  assignee?: string;
  parentSlug?: string;
  search?: string;
  limit?: number;
  offset?: number;
  channel?: string;
}

async function artifactList(params: ArtifactListParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const searchParams = new URLSearchParams();

  if (params.type) searchParams.set("type", params.type);
  if (params.status) searchParams.set("status", params.status);
  if (params.assignee) searchParams.set("assignee", params.assignee);
  if (params.parentSlug) searchParams.set("parentSlug", params.parentSlug);
  if (params.search) searchParams.set("search", params.search);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));

  const query = searchParams.toString();
  const path = `/channels/${channelId}/artifacts${query ? `?${query}` : ""}`;

  const response = await httpRequest("GET", path);

  if (!response.ok) {
    throw new Error(`Failed to list artifacts: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

interface ArtifactGlobParams {
  pattern?: string;
  channel?: string;
}

// Tree node structure returned by server
interface ArtifactTreeNode {
  slug: string;
  path: string;
  type: string;
  title?: string;
  status: string;
  assignees: string[];
  children: ArtifactTreeNode[];
}

/**
 * Format tree nodes into PowPow's compact tree format:
 *
 * /parent-slug
 *   /child-slug :task (done)
 *     grandchild-slug :task (in_progress) @assignee
 *   another-child :code
 * root-level-doc
 * some-task :task (pending) @fox @bear
 *
 * Key formatting:
 * - Indentation shows tree hierarchy (2 spaces per level)
 * - Leading `/` for items with children
 * - Type suffix `:task`, `:code`, `:decision` (`:doc` is default, omitted)
 * - Status in parens for tasks: `(done)`, `(pending)`, `(in_progress)`, `(blocked)`
 * - Assignees as `@callsign`
 */
function formatTreeNode(node: ArtifactTreeNode, indent: number = 0): string {
  const parts: string[] = [];
  const indentStr = "  ".repeat(indent);

  // Slug with leading / if has children
  const hasChildren = node.children && node.children.length > 0;
  const slug = hasChildren ? `/${node.slug}` : node.slug;
  parts.push(slug);

  // Type suffix (omit :doc as it's the default)
  if (node.type && node.type !== "doc") {
    parts.push(`:${node.type}`);
  }

  // Status in parens for tasks (and other stateful artifacts)
  if (node.status && node.status !== "published") {
    parts.push(`(${node.status})`);
  }

  // Assignees as @callsign
  if (node.assignees && node.assignees.length > 0) {
    for (const assignee of node.assignees) {
      parts.push(`@${assignee}`);
    }
  }

  let result = indentStr + parts.join(" ");

  // Recursively format children
  if (hasChildren) {
    for (const child of node.children) {
      result += "\n" + formatTreeNode(child, indent + 1);
    }
  }

  return result;
}

function formatTree(nodes: ArtifactTreeNode[]): string {
  if (!nodes || nodes.length === 0) {
    return "(empty)";
  }
  return nodes.map(node => formatTreeNode(node, 0)).join("\n");
}

async function artifactGlob(params: ArtifactGlobParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const pattern = params.pattern ?? "/**";
  const path = `/channels/${channelId}/artifacts/tree?pattern=${encodeURIComponent(pattern)}`;

  const response = await httpRequest("GET", path);

  if (!response.ok) {
    throw new Error(`Failed to glob artifacts: ${response.data.error ?? response.status}`);
  }

  // Format as PowPow's compact tree format
  const tree = response.data.tree as ArtifactTreeNode[];
  return formatTree(tree);
}

interface CASChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface ArtifactUpdateParams {
  slug: string;
  changes: CASChange[];
  channel?: string;
}

async function artifactUpdate(params: ArtifactUpdateParams): Promise<string> {
  const channelId = getChannelId(params.channel);

  // Pass changes directly (camelCase throughout)
  const transformedChanges = params.changes.map((change) => ({
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
  }));

  const response = await httpRequest(
    "PATCH",
    `/channels/${channelId}/artifacts/${encodeURIComponent(params.slug)}`,
    {
      changes: transformedChanges,
      updatedBy: CIKADA_CALLSIGN,
    }
  );

  if (response.status === 409) {
    return JSON.stringify({
      success: false,
      error: "CAS conflict",
      conflict: response.data.conflict,
    }, null, 2);
  }

  if (!response.ok) {
    throw new Error(`Failed to update artifact: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

interface ArtifactEditParams {
  slug: string;
  old_string: string;
  new_string: string;
  channel?: string;
}

async function artifactEdit(params: ArtifactEditParams): Promise<string> {
  const channelId = getChannelId(params.channel);

  // First, read the artifact to get current content
  const readResponse = await httpRequest(
    "GET",
    `/channels/${channelId}/artifacts/${encodeURIComponent(params.slug)}`
  );

  if (!readResponse.ok) {
    throw new Error(`Failed to read artifact: ${readResponse.data.error ?? readResponse.status}`);
  }

  const artifact = readResponse.data;
  const content = artifact.content ?? "";

  // Check that old_string exists exactly once
  const matches = content.split(params.old_string).length - 1;
  if (matches === 0) {
    throw new Error(`old_string not found in artifact content`);
  }
  if (matches > 1) {
    throw new Error(`old_string matches ${matches} times (ambiguous) - use a longer string`);
  }

  // Replace and update with CAS
  const newContent = content.replace(params.old_string, params.new_string);

  const updateResponse = await httpRequest(
    "PATCH",
    `/channels/${channelId}/artifacts/${encodeURIComponent(params.slug)}`,
    {
      changes: [
        { field: "content", oldValue: content, newValue: newContent },
      ],
      updatedBy: CIKADA_CALLSIGN,
    }
  );

  if (updateResponse.status === 409) {
    return JSON.stringify({
      success: false,
      error: "Content was modified by someone else (CAS conflict)",
      conflict: updateResponse.data.conflict,
    }, null, 2);
  }

  if (!updateResponse.ok) {
    throw new Error(`Failed to update artifact: ${updateResponse.data.error ?? updateResponse.status}`);
  }

  return JSON.stringify(updateResponse.data, null, 2);
}

interface ArtifactArchiveParams {
  slug: string;
  channel?: string;
}

async function artifactArchive(params: ArtifactArchiveParams): Promise<string> {
  const channelId = getChannelId(params.channel);

  const response = await httpRequest(
    "DELETE",
    `/channels/${channelId}/artifacts/${encodeURIComponent(params.slug)}?updatedBy=${encodeURIComponent(CIKADA_CALLSIGN)}`
  );

  if (!response.ok) {
    throw new Error(`Failed to archive artifact: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

// =============================================================================
// Message Tool Implementations
// =============================================================================

interface StoredMessage {
  id: string;
  channelId: string;
  sender: string;
  senderType: string;
  type: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
}

interface MessageGetParams {
  channel?: string;
  limit?: number;
  before?: string;
  since?: string;
}

async function messageGet(params: MessageGetParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const searchParams = new URLSearchParams();

  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.before) searchParams.set("before", params.before);
  if (params.since) searchParams.set("since", params.since);

  const query = searchParams.toString();
  const path = `/channels/${channelId}/messages${query ? `?${query}` : ""}`;

  const response = await httpRequest("GET", path);

  if (!response.ok) {
    throw new Error(`Failed to get messages: ${response.data.error ?? response.status}`);
  }

  const messages = response.data.messages as StoredMessage[];

  // Format messages for readability
  const formatted = messages.map((msg) => ({
    id: msg.id,
    sender: msg.sender,
    senderType: msg.senderType,
    timestamp: msg.timestamp,
    content: msg.content,
  }));

  return JSON.stringify({
    count: formatted.length,
    cursor: response.data.cursor,
    messages: formatted,
  }, null, 2);
}

interface MessageSearchParams {
  channel?: string;
  query?: string;
  sender?: string;
  limit?: number;
}

async function messageSearch(params: MessageSearchParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const limit = params.limit ?? 100;

  // Fetch messages (more than requested to filter client-side)
  const fetchLimit = Math.min(limit * 3, 500); // Fetch extra to filter
  const path = `/channels/${channelId}/messages?limit=${fetchLimit}`;

  const response = await httpRequest("GET", path);

  if (!response.ok) {
    throw new Error(`Failed to get messages: ${response.data.error ?? response.status}`);
  }

  let messages = response.data.messages as StoredMessage[];

  // Client-side filtering
  if (params.sender) {
    const senderLower = params.sender.toLowerCase();
    messages = messages.filter((msg) =>
      msg.sender.toLowerCase() === senderLower
    );
  }

  if (params.query) {
    const queryLower = params.query.toLowerCase();
    messages = messages.filter((msg) => {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      return content.toLowerCase().includes(queryLower);
    });
  }

  // Apply limit after filtering
  messages = messages.slice(0, limit);

  // Format messages for readability
  const formatted = messages.map((msg) => ({
    id: msg.id,
    sender: msg.sender,
    senderType: msg.senderType,
    timestamp: msg.timestamp,
    content: msg.content,
  }));

  return JSON.stringify({
    count: formatted.length,
    query: params.query,
    sender: params.sender,
    messages: formatted,
  }, null, 2);
}

interface MessageContextParams {
  message_id: string;
  channel?: string;
  before?: number;
  after?: number;
}

async function messageContext(params: MessageContextParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const beforeCount = params.before ?? 5;
  const afterCount = params.after ?? 5;

  // Fetch messages before the target
  const beforePath = `/channels/${channelId}/messages?before=${params.message_id}&limit=${beforeCount}`;
  const beforeResponse = await httpRequest("GET", beforePath);

  if (!beforeResponse.ok) {
    throw new Error(`Failed to get messages: ${beforeResponse.data.error ?? beforeResponse.status}`);
  }

  // Fetch messages after the target (including the target)
  const afterPath = `/channels/${channelId}/messages?since=${params.message_id}&limit=${afterCount + 1}`;
  const afterResponse = await httpRequest("GET", afterPath);

  if (!afterResponse.ok) {
    throw new Error(`Failed to get messages: ${afterResponse.data.error ?? afterResponse.status}`);
  }

  const beforeMessages = (beforeResponse.data.messages as StoredMessage[]).reverse();
  const afterMessages = afterResponse.data.messages as StoredMessage[];

  // Find the target message (should be first in afterMessages if since is exclusive)
  // Since ULID comparison is >, the target message won't be in afterMessages
  // We need to fetch it separately
  const targetInAfter = afterMessages.find((msg) => msg.id === params.message_id);

  let targetMessage: StoredMessage | undefined;
  let contextAfter: StoredMessage[];

  if (targetInAfter) {
    targetMessage = targetInAfter;
    contextAfter = afterMessages.filter((msg) => msg.id !== params.message_id).slice(0, afterCount);
  } else {
    // Target message is not in the results, it's between before and after
    // Try to get it from the gap - fetch one message at the ID
    // The API uses > for since, so we need a different approach
    // Fetch a small window that should include the target
    const windowPath = `/channels/${channelId}/messages?limit=${beforeCount + afterCount + 10}`;
    const windowResponse = await httpRequest("GET", windowPath);

    if (windowResponse.ok) {
      const allMessages = windowResponse.data.messages as StoredMessage[];
      targetMessage = allMessages.find((msg) => msg.id === params.message_id);
    }
    contextAfter = afterMessages.slice(0, afterCount);
  }

  // Format messages
  const formatMsg = (msg: StoredMessage) => ({
    id: msg.id,
    sender: msg.sender,
    senderType: msg.senderType,
    timestamp: msg.timestamp,
    content: msg.content,
  });

  return JSON.stringify({
    before: beforeMessages.map(formatMsg),
    target: targetMessage ? formatMsg(targetMessage) : null,
    after: contextAfter.map(formatMsg),
  }, null, 2);
}

// =============================================================================
// Attachment Tool Implementation
// =============================================================================

interface AttachmentUploadParams {
  path: string;        // Local file path in workspace
  channel?: string;
  filename?: string;   // Override original filename
  title?: string;      // Optional title for the attachment
  description?: string; // Optional description of the attachment
  messageId?: string;  // Link attachment to an additional message (attachment auto-creates its own message)
}

interface AttachmentUploadResult {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}

async function attachmentUpload(params: AttachmentUploadParams): Promise<string> {
  const channelId = getChannelId(params.channel);
  const filePath = params.path;

  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Detect MIME type from extension
  const mimeType = getMimeType(filePath);
  if (!mimeType) {
    const ext = path.extname(filePath).toLowerCase();
    const allowedExtensions = Object.keys(MIME_TYPES).join(", ");
    throw new Error(`Unsupported file type: ${ext}. Allowed: ${allowedExtensions}`);
  }

  // Read file
  const fileData = fs.readFileSync(filePath);

  // Use provided filename or extract from path
  const filename = params.filename ?? path.basename(filePath);

  // Create multipart body with all optional fields
  const { body, boundary } = createMultipartBody({
    filename,
    fileData,
    mimeType,
    uploadedBy: CIKADA_CALLSIGN,
    title: params.title,
    description: params.description,
    messageId: params.messageId,
    customFilename: params.filename, // Pass custom filename separately
  });

  // POST to attachment endpoint
  const url = `${CIKADA_API_URL}/channels/${channelId}/attachments`;

  // Build headers - include auth token for container authentication
  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  };
  if (CIKADA_AUTH_TOKEN) {
    headers["X-Cikada-Token"] = CIKADA_AUTH_TOKEN;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: new Uint8Array(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Upload failed: ${data.error ?? response.status}`);
  }

  // Extract and return the relevant fields
  const attachment = data.attachment;
  const result = {
    id: attachment.id,
    url: attachment.url,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    messageId: data.messageId, // The auto-created message ID
    title: attachment.title,
    description: attachment.description,
    // Attachments now auto-create their own message, so they appear immediately in chat
    note: "Attachment uploaded and will appear in the chat timeline. No additional linking required.",
  };

  return JSON.stringify(result, null, 2);
}

interface AttachmentLinkParams {
  attachmentId: string;
  messageId: string;
  channel?: string;
}

async function attachmentLink(params: AttachmentLinkParams): Promise<string> {
  const channelId = getChannelId(params.channel);

  const response = await httpRequest(
    "PATCH",
    `/channels/${channelId}/attachments/${encodeURIComponent(params.attachmentId)}`,
    { messageId: params.messageId }
  );

  if (!response.ok) {
    throw new Error(`Failed to link attachment: ${response.data.error ?? response.status}`);
  }

  return JSON.stringify(response.data, null, 2);
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new Server(
  {
    name: "cikada-tools",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Common channel property for all tools
const channelProperty = {
  type: "string",
  description: "Optional channel ID override (defaults to agent's assigned channel)",
};

// Tool definitions
const TOOLS = [
  {
    name: "artifact_create",
    description: "Create a new artifact on the Cikada board",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Immutable identifier (e.g., 'auth-api-spec', 'config.json')",
        },
        type: {
          type: "string",
          enum: ["doc", "task", "decision", "code", "asset"],
          description: "Artifact type",
        },
        tldr: {
          type: "string",
          description: "1-3 sentence summary",
        },
        content: {
          type: "string",
          description: "Markdown for docs, raw code for code artifacts",
        },
        title: {
          type: "string",
          description: "Optional display name",
        },
        parentSlug: {
          type: "string",
          description: "Parent artifact for tree structure",
        },
        status: {
          type: "string",
          enum: ["draft", "published", "pending", "in_progress", "done", "blocked"],
          description: "Artifact status",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Agent callsigns (for tasks)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Freeform tags",
        },
        channel: channelProperty,
      },
      required: ["slug", "type", "tldr", "content"],
    },
  },
  {
    name: "artifact_read",
    description: "Read a single artifact's full content",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Artifact slug to read",
        },
        channel: channelProperty,
      },
      required: ["slug"],
    },
  },
  {
    name: "artifact_list",
    description: "Query artifacts with filters. Returns summaries (not full content)",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: "Filter by type",
        },
        status: {
          type: "string",
          description: "Filter by status",
        },
        assignee: {
          type: "string",
          description: "Filter tasks by assignee",
        },
        parentSlug: {
          type: "string",
          description: "'root' for top-level, or specific parent slug",
        },
        search: {
          type: "string",
          description: "Keyword search (slug, title, tldr, content)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
        offset: {
          type: "number",
          description: "For pagination",
        },
        channel: channelProperty,
      },
    },
  },
  {
    name: "artifact_glob",
    description: "Get tree view of artifacts matching a glob pattern",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (default: '/**'). Examples: '/**', '/auth-system/**', '/**/*.ts', '/*'",
        },
        channel: channelProperty,
      },
    },
  },
  {
    name: "artifact_update",
    description: "Atomic update with compare-and-swap (CAS) for conflict prevention. All changes are atomic - all succeed or all fail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Artifact slug to update",
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                description: "Field name: title, tldr, status, content, parentSlug, assignees, labels",
              },
              oldValue: {
                description: "Expected current value (null if unset)",
              },
              newValue: {
                description: "New value to set",
              },
            },
            required: ["field", "oldValue", "newValue"],
          },
          description: "Array of field changes with CAS",
        },
        channel: channelProperty,
      },
      required: ["slug", "changes"],
    },
  },
  {
    name: "artifact_edit",
    description: "Surgical find-replace on content. Returns error if old_string not found or matches multiple times.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Artifact slug to edit",
        },
        old_string: {
          type: "string",
          description: "Text to find (must match exactly once)",
        },
        new_string: {
          type: "string",
          description: "Replacement text",
        },
        channel: channelProperty,
      },
      required: ["slug", "old_string", "new_string"],
    },
  },
  {
    name: "artifact_archive",
    description: "Soft delete - sets status to 'archived'",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Artifact slug to archive",
        },
        channel: channelProperty,
      },
      required: ["slug"],
    },
  },
  // Message tools
  {
    name: "message_get",
    description: "Get recent messages from the channel. Supports cursor-based pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: channelProperty,
        limit: {
          type: "number",
          description: "Max messages to return (default: 50)",
        },
        before: {
          type: "string",
          description: "Return messages before this ULID (for pagination)",
        },
        since: {
          type: "string",
          description: "Return messages after this ULID (for sync/updates)",
        },
      },
    },
  },
  {
    name: "message_search",
    description: "Search messages by keyword and/or sender. Client-side filtering on recent messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: channelProperty,
        query: {
          type: "string",
          description: "Keyword to search for in message content (case-insensitive)",
        },
        sender: {
          type: "string",
          description: "Filter by sender callsign (exact match, case-insensitive)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 100)",
        },
      },
    },
  },
  {
    name: "message_context",
    description: "Get messages around a specific message ID. Useful for understanding conversation context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "ULID of the target message",
        },
        channel: channelProperty,
        before: {
          type: "number",
          description: "Number of messages before target (default: 5)",
        },
        after: {
          type: "number",
          description: "Number of messages after target (default: 5)",
        },
      },
      required: ["message_id"],
    },
  },
  // Attachment tools
  {
    name: "attachment_upload",
    description: "Upload a file from the local workspace to the channel. The file will appear as a separate message in the chat timeline. Supports images (png, jpg, gif, svg, webp), audio (mp3, wav, ogg, webm), and PDF files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file in the local workspace (relative or absolute)",
        },
        filename: {
          type: "string",
          description: "Optional: Override the filename for download (defaults to basename from path)",
        },
        title: {
          type: "string",
          description: "Optional: A title for the attachment (displayed prominently in chat)",
        },
        description: {
          type: "string",
          description: "Optional: A description of what the attachment contains",
        },
        messageId: {
          type: "string",
          description: "Optional: Additionally link this attachment to an existing message ID (the attachment will still appear as its own message)",
        },
        channel: channelProperty,
      },
      required: ["path"],
    },
  },
  {
    name: "attachment_link",
    description: "Link an existing attachment to a message. Use this after uploading an attachment to associate it with a specific message, so it appears inline when the message is displayed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        attachmentId: {
          type: "string",
          description: "The ID of the attachment to link (returned from attachment_upload)",
        },
        messageId: {
          type: "string",
          description: "The message ID to link the attachment to",
        },
        channel: channelProperty,
      },
      required: ["attachmentId", "messageId"],
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!isConfigured) {
    return {
      tools: [],
    };
  }

  return {
    tools: TOOLS,
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!isConfigured) {
    return {
      content: [
        {
          type: "text",
          text: "Cikada artifact tools not configured. Missing environment variables: " +
            (!CIKADA_API_URL ? "CIKADA_API_URL " : "") +
            (!CIKADA_CHANNEL_ID ? "CIKADA_CHANNEL_ID " : "") +
            (!CIKADA_CALLSIGN ? "CIKADA_CALLSIGN" : ""),
        },
      ],
      isError: true,
    };
  }

  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "artifact_create":
        result = await artifactCreate(args as unknown as ArtifactCreateParams);
        break;
      case "artifact_read":
        result = await artifactRead(args as unknown as ArtifactReadParams);
        break;
      case "artifact_list":
        result = await artifactList(args as unknown as ArtifactListParams);
        break;
      case "artifact_glob":
        result = await artifactGlob(args as unknown as ArtifactGlobParams);
        break;
      case "artifact_update":
        result = await artifactUpdate(args as unknown as ArtifactUpdateParams);
        break;
      case "artifact_edit":
        result = await artifactEdit(args as unknown as ArtifactEditParams);
        break;
      case "artifact_archive":
        result = await artifactArchive(args as unknown as ArtifactArchiveParams);
        break;
      // Message tools
      case "message_get":
        result = await messageGet(args as unknown as MessageGetParams);
        break;
      case "message_search":
        result = await messageSearch(args as unknown as MessageSearchParams);
        break;
      case "message_context":
        result = await messageContext(args as unknown as MessageContextParams);
        break;
      // Attachment tools
      case "attachment_upload":
        result = await attachmentUpload(args as unknown as AttachmentUploadParams);
        break;
      case "attachment_link":
        result = await attachmentLink(args as unknown as AttachmentLinkParams);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
});

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  console.error("[MCP] Starting Cikada Tools server (artifacts + messages)");
  console.error(`[MCP] API URL: ${CIKADA_API_URL || "(not set)"}`);
  console.error(`[MCP] Channel ID: ${CIKADA_CHANNEL_ID || "(not set)"}`);
  console.error(`[MCP] Callsign: ${CIKADA_CALLSIGN || "(not set)"}`);
  console.error(`[MCP] Auth Token: ${CIKADA_AUTH_TOKEN ? "(set)" : "(not set)"}`);
  console.error(`[MCP] Configured: ${isConfigured}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Server connected via stdio");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
