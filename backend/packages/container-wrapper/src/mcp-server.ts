/**
 * MCP Cast Tools Server
 *
 * Stdio MCP server that runs inside agent containers and provides
 * Cast platform tools (artifacts, messages) to Claude Code.
 *
 * Tools are fetched dynamically from the backend at startup via /tools/list,
 * keeping definitions in sync without duplication.
 *
 * Configuration via environment:
 * - CAST_API_URL - Backend base URL (e.g., http://host.docker.internal:3232)
 * - CAST_CHANNEL_ID - Agent's assigned channel
 * - CAST_CALLSIGN - Agent's callsign
 * - CAST_AUTH_TOKEN - Container auth token
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// Configuration
// =============================================================================

const CAST_API_URL = process.env.CAST_API_URL ?? "";
const CAST_CHANNEL_ID = process.env.CAST_CHANNEL_ID ?? "";
const CAST_CALLSIGN = process.env.CAST_CALLSIGN ?? "";
const CAST_AUTH_TOKEN = process.env.CAST_AUTH_TOKEN ?? "";

const isConfigured = CAST_API_URL && CAST_CHANNEL_ID && CAST_CALLSIGN;

// =============================================================================
// HTTP Client
// =============================================================================

interface McpToolsListResponse {
  tools: Tool[];
}

interface McpToolCallResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Make an HTTP request to the Cast backend MCP endpoints.
 */
async function mcpRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${CAST_API_URL}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Use X-Cast-Token header for container auth
  if (CAST_AUTH_TOKEN) {
    headers["X-Cast-Token"] = CAST_AUTH_TOKEN;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `MCP request failed: ${response.status} ${errorData.error ?? response.statusText}`
    );
  }

  return response.json();
}

/**
 * Fetch available tools from the backend.
 */
async function fetchTools(): Promise<Tool[]> {
  const response = await mcpRequest<McpToolsListResponse>(
    "POST",
    `/mcp/${CAST_CHANNEL_ID}/tools/list`,
    {}
  );
  return response.tools;
}

/**
 * Call a tool on the backend.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<McpToolCallResponse> {
  return mcpRequest<McpToolCallResponse>(
    "POST",
    `/mcp/${CAST_CHANNEL_ID}/tools/call`,
    { name, arguments: args }
  );
}

// =============================================================================
// MCP Server
// =============================================================================

const server = new Server(
  {
    name: "cast-tools",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Cache for tools fetched from backend
let cachedTools: Tool[] = [];

/**
 * List tools handler - fetches from backend and caches.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!isConfigured) {
    console.error("[MCP] Not configured, returning empty tools list");
    return { tools: [] };
  }

  try {
    // Fetch tools from backend (refresh cache)
    cachedTools = await fetchTools();
    console.error(`[MCP] Fetched ${cachedTools.length} tools from backend`);
    return { tools: cachedTools };
  } catch (error) {
    console.error("[MCP] Failed to fetch tools:", error);
    // Return cached tools if available, otherwise empty
    return { tools: cachedTools };
  }
});

/**
 * Call tool handler - forwards to backend.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!isConfigured) {
    return {
      content: [
        {
          type: "text",
          text:
            "Cast tools not configured. Missing environment variables: " +
            (!CAST_API_URL ? "CAST_API_URL " : "") +
            (!CAST_CHANNEL_ID ? "CAST_CHANNEL_ID " : "") +
            (!CAST_CALLSIGN ? "CAST_CALLSIGN" : ""),
        },
      ],
      isError: true,
    };
  }

  const { name, arguments: args } = request.params;

  try {
    // Forward tool call to backend
    const response = await callTool(name, (args as Record<string, unknown>) ?? {});
    return response;
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
  console.error("[MCP] Starting Cast Tools server");
  console.error(`[MCP] API URL: ${CAST_API_URL || "(not set)"}`);
  console.error(`[MCP] Channel: ${CAST_CHANNEL_ID || "(not set)"}`);
  console.error(`[MCP] Callsign: ${CAST_CALLSIGN || "(not set)"}`);
  console.error(`[MCP] Auth Token: ${CAST_AUTH_TOKEN ? "(set)" : "(not set)"}`);
  console.error(`[MCP] Configured: ${isConfigured}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Server connected via stdio");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
