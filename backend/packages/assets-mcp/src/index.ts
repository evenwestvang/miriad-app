/**
 * @miriad-systems/assets-mcp
 *
 * MCP server for uploading and downloading Cast channel assets.
 * Enables agents with file system access to interact with binary assets.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Tool input types
export interface UploadAssetInput {
  path: string;
  slug: string;
  tldr: string;
  title?: string;
  parentSlug?: string;
  attachToLatestMessage?: boolean;
}

export interface DownloadAssetInput {
  slug: string;
  path: string;
  overwrite?: boolean;
}

// Tool output types
export interface UploadAssetOutput {
  slug: string;
  contentType: string;
  fileSize: number;
  url: string;
}

export interface DownloadAssetOutput {
  path: string;
  contentType: string;
  fileSize: number;
}

// Configuration
export interface AssetsMcpConfig {
  apiUrl: string;
  containerToken: string;
  channelId: string;
}

/**
 * Validates that required environment variables are set.
 * Returns config object or throws with clear error message.
 */
export function getConfigFromEnv(): AssetsMcpConfig {
  const apiUrl = process.env.CAST_API_URL;
  const containerToken = process.env.CAST_CONTAINER_TOKEN;
  const channelId = process.env.CAST_CHANNEL_ID;

  const missing: string[] = [];
  if (!apiUrl) missing.push("CAST_API_URL");
  if (!containerToken) missing.push("CAST_CONTAINER_TOKEN");
  if (!channelId) missing.push("CAST_CHANNEL_ID");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    apiUrl: apiUrl!,
    containerToken: containerToken!,
    channelId: channelId!,
  };
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Data
    json: 'application/json',
    xml: 'application/xml',
    csv: 'text/csv',
    // Archives
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    // Audio/Video
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    // Text
    txt: 'text/plain',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'application/typescript',
    md: 'text/markdown',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Upload a local file to the Cast channel.
 * Uses presigned URL flow: presign → upload → confirm
 */
export async function uploadAsset(
  input: UploadAssetInput,
  config: AssetsMcpConfig,
): Promise<UploadAssetOutput> {
  // Validate input
  if (!input.path) throw new Error("path is required");
  if (!input.slug) throw new Error("slug is required");

  // Resolve and validate path
  const filePath = path.resolve(input.path);

  // Check file exists and get stats
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(`Cannot access file: ${e.message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const fileSize = stats.size;
  const contentType = getMimeType(filePath);

  // Step 1: Get presigned URL
  const presignUrl = `${config.apiUrl}/api/assets/${config.channelId}/presign`;
  const presignResponse = await fetch(presignUrl, {
    method: "POST",
    headers: {
      Authorization: `Container ${config.containerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: input.slug,
      contentType,
      fileSize,
      tldr: input.tldr,
      title: input.title,
      parentSlug: input.parentSlug,
      attachToLatestMessage: input.attachToLatestMessage,
    }),
  });

  if (!presignResponse.ok) {
    const errorText = await presignResponse.text();
    throw new Error(`Failed to get presigned URL (${presignResponse.status}): ${errorText}`);
  }

  const presignResult = (await presignResponse.json()) as {
    uploadUrl: string;
    method: string;
    headers: Record<string, string>;
  };

  // Step 2: Upload to the presigned URL (S3 in prod, local server in dev)
  const fileBuffer = await fs.readFile(filePath);
  const uploadResponse = await fetch(presignResult.uploadUrl, {
    method: presignResult.method,
    headers: presignResult.headers,
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Upload failed (${uploadResponse.status}): ${errorText}`);
  }

  // Step 3: Confirm upload and create artifact
  const confirmUrl = `${config.apiUrl}/api/assets/${config.channelId}/confirm`;
  const confirmResponse = await fetch(confirmUrl, {
    method: "POST",
    headers: {
      Authorization: `Container ${config.containerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: input.slug,
      tldr: input.tldr,
      title: input.title,
      parentSlug: input.parentSlug,
      attachToLatestMessage: input.attachToLatestMessage,
    }),
  });

  if (!confirmResponse.ok) {
    const errorText = await confirmResponse.text();
    throw new Error(`Failed to confirm upload (${confirmResponse.status}): ${errorText}`);
  }

  const result = (await confirmResponse.json()) as {
    slug: string;
    contentType: string;
    fileSize: number;
    url: string;
  };

  return {
    slug: result.slug,
    contentType: result.contentType,
    fileSize: result.fileSize,
    url: result.url,
  };
}

/**
 * Download an asset from the Cast channel to local disk.
 */
export async function downloadAsset(
  input: DownloadAssetInput,
  config: AssetsMcpConfig,
): Promise<DownloadAssetOutput> {
  // Validate input
  if (!input.slug) throw new Error("slug is required");
  if (!input.path) throw new Error("path is required");

  const filePath = path.resolve(input.path);
  const overwrite = input.overwrite ?? false;

  // Check if file exists (only if not overwriting)
  if (!overwrite) {
    try {
      await fs.access(filePath);
      // If we get here, file exists and overwrite is false
      throw new Error(
        `File already exists: ${filePath}. Set overwrite=true to replace.`,
      );
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT means file doesn't exist - that's what we want
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });

  // Download via container-authenticated API endpoint
  const url = `${config.apiUrl}/api/assets/${config.channelId}/${input.slug}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Container ${config.containerToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Asset not found: ${input.slug}`);
    }
    const errorText = await response.text();
    throw new Error(`Download failed (${response.status}): ${errorText}`);
  }

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await response.arrayBuffer();

  // Write to disk
  await fs.writeFile(filePath, Buffer.from(buffer));

  return {
    path: filePath,
    contentType,
    fileSize: buffer.byteLength,
  };
}

/**
 * Create and configure the MCP server.
 */
export function createServer(config: AssetsMcpConfig): Server {
  const server = new Server(
    {
      name: "assets-mcp",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "upload_asset",
        description:
          "Upload a local file to the Cast channel as an asset. " +
          "Supports images, PDFs, audio, video, and other binary files.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description:
                "Absolute or relative path to the local file to upload",
            },
            slug: {
              type: "string",
              description:
                "Unique identifier for the asset. Always use appropriate file extension! (e.g., 'screenshot-login.jpg', 'design-v2.png')",
            },
            tldr: {
              type: "string",
              description: "Brief description of what this asset contains",
            },
            title: {
              type: "string",
              description: "Optional display name for the asset",
            },
            parentSlug: {
              type: "string",
              description:
                "Optional parent artifact slug for tree organization",
            },
            attachToLatestMessage: {
              type: "boolean",
              description:
                "If true, attach this asset to your most recent message in the channel. " +
                "You must send a message first using send_message, then upload with this flag. " +
                "The asset will be hidden from the board and displayed inline with the message.",
            },
          },
          required: ["path", "slug"],
        },
      },
      {
        name: "download_asset",
        description:
          "Download an asset from the Cast channel to local disk. " +
          "Use this to retrieve images, documents, or other files shared in the channel.",
        inputSchema: {
          type: "object" as const,
          properties: {
            slug: {
              type: "string",
              description: "The asset identifier to download",
            },
            path: {
              type: "string",
              description: "Local path where the file should be saved",
            },
            overwrite: {
              type: "boolean",
              description: "If true, overwrite existing file. Default: false",
              default: false,
            },
          },
          required: ["slug", "path"],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "upload_asset") {
        const input = args as unknown as UploadAssetInput;
        const result = await uploadAsset(input, config);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "download_asset") {
        const input = args as unknown as DownloadAssetInput;
        const result = await downloadAsset(input, config);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Main entry point - starts the MCP server with stdio transport.
 */
export async function main(): Promise<void> {
  const config = getConfigFromEnv();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
