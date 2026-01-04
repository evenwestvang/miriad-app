/**
 * MCP Client (HTTP Transport)
 *
 * HTTP-based MCP client for connecting to MCP servers.
 * Supports the standard MCP protocol over HTTP.
 *
 * Key features:
 * - HTTP transport (stateless, Lambda-compatible)
 * - Tool discovery via POST to /tools/list
 * - Tool execution via POST to /tools/call
 */

import { EventEmitter } from "events";

// =============================================================================
// Types
// =============================================================================

export interface MCPServerConfig {
  /** Unique name for this server (used in tool namespacing) */
  name: string;
  /** Transport type - HTTP only for Lambda compatibility */
  transport: "http";
  /** Base URL for the MCP server (e.g., https://api.example.com/mcp/channel-id) */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

export interface MCPTool {
  /** Tool name (without namespace) */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  /** Whether the call was successful */
  isError: boolean;
  /** Result content */
  content: unknown;
}

// HTTP response types
interface MCPListToolsResponse {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface MCPCallToolResponse {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

// =============================================================================
// MCP Client
// =============================================================================

/**
 * MCP client for HTTP transport.
 * Connects to MCP servers, discovers tools, and executes them.
 */
export class MCPClient extends EventEmitter {
  private config: MCPServerConfig;
  private tools: MCPTool[] = [];
  private connected = false;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the server name (used for tool namespacing).
   */
  get name(): string {
    return this.config.name;
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to the MCP server (validates endpoint exists).
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.config.transport !== "http") {
      throw new Error(`Transport "${this.config.transport}" not supported. Use "http".`);
    }

    if (!this.config.url) {
      throw new Error("HTTP transport requires a url");
    }

    console.log(`[MCPClient:${this.name}] Connecting via HTTP: ${this.config.url}`);

    // Validate the endpoint exists by listing tools
    try {
      await this.listTools();
      this.connected = true;
      console.log(`[MCPClient:${this.name}] Connected successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to MCP server: ${message}`);
    }
  }

  /**
   * List available tools from the server.
   */
  async listTools(): Promise<MCPTool[]> {
    console.log(`[MCPClient:${this.name}] Listing tools...`);

    const response = await this.httpRequest<MCPListToolsResponse>("/tools/list", {
      method: "POST",
      body: {},
    });

    this.tools = response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));

    console.log(`[MCPClient:${this.name}] Found ${this.tools.length} tools`);
    return this.tools;
  }

  /**
   * Call a tool on the server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.connected) {
      await this.connect();
    }

    console.log(`[MCPClient:${this.name}] Calling tool: ${name}`);

    try {
      const result = await this.httpRequest<MCPCallToolResponse>("/tools/call", {
        method: "POST",
        body: {
          name,
          arguments: args,
        },
      });

      // Extract text content from result
      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      return {
        isError: result.isError ?? false,
        content: textContent || result.content,
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Disconnect from the MCP server (no-op for HTTP - stateless).
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    console.log(`[MCPClient:${this.name}] Disconnecting (HTTP - no action needed)`);
    this.connected = false;
    this.tools = [];
  }

  /**
   * Make an HTTP request to the MCP server.
   */
  private async httpRequest<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown }
  ): Promise<T> {
    const url = `${this.config.url}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    const fetchOptions: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }
}
