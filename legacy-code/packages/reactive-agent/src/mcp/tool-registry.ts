/**
 * Tool Registry
 *
 * Unified registry that manages:
 * - MCP tools (from connected servers, with namespacing)
 * - Agent-defined tools (from agent configuration)
 *
 * Tool namespacing:
 * - Agent tools: plain names (e.g., "get_weather")
 * - MCP tools: mcp__<server>__<tool> (e.g., "mcp__powpow__send_message")
 */

import type { MCPClient, MCPTool, MCPServerConfig } from "./mcp-client.js";
import type { ToolDefinition } from "../adapters/llm.js";
import type { ToolAdapter, ToolResult, ToolExecutionContext } from "../adapters/tools.js";

// =============================================================================
// Types
// =============================================================================

export interface RegisteredTool {
  /** Full tool name (with namespace for MCP tools) */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
  /** Source of the tool */
  source: "agent" | "mcp";
  /** MCP server name (if source is "mcp") */
  mcpServer?: string;
  /** Original tool name (without namespace) */
  originalName?: string;
}

export interface AgentToolDefinition {
  description: string;
  parameters: unknown; // Zod schema or JSON schema
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<unknown>;
}

// =============================================================================
// Tool Registry
// =============================================================================

/**
 * Manages tool registration, discovery, and execution.
 * Implements ToolAdapter interface for use with reactive agent.
 */
export class ToolRegistry implements ToolAdapter {
  private tools = new Map<string, RegisteredTool>();
  private agentTools = new Map<string, AgentToolDefinition>();
  private mcpConfigs = new Map<string, MCPServerConfig>();
  private mcpClients = new Map<string, MCPClient>();
  private mcpToolsLoaded = new Set<string>();
  private mcpClientFactory?: (config: MCPServerConfig) => MCPClient;

  /**
   * Set the factory for creating MCP clients.
   * Required for lazy connection to MCP servers.
   */
  setMcpClientFactory(factory: (config: MCPServerConfig) => MCPClient): void {
    this.mcpClientFactory = factory;
  }

  /**
   * Register agent-defined tools.
   */
  registerAgentTools(tools: Record<string, AgentToolDefinition>): void {
    for (const [name, def] of Object.entries(tools)) {
      this.agentTools.set(name, def);

      // Convert Zod schema to JSON schema if needed
      const inputSchema = this.extractInputSchema(def.parameters);

      this.tools.set(name, {
        name,
        description: def.description,
        inputSchema,
        source: "agent",
      });
    }

    console.log(`[ToolRegistry] Registered ${Object.keys(tools).length} agent tools`);
  }

  /**
   * Register MCP server configurations (tools loaded lazily).
   */
  registerMcpServers(configs: MCPServerConfig[]): void {
    for (const config of configs) {
      this.mcpConfigs.set(config.name, config);
    }

    console.log(`[ToolRegistry] Registered ${configs.length} MCP server configs`);
  }

  /**
   * Load tools from an MCP client (called on-demand or during preload).
   */
  async loadMcpTools(client: MCPClient): Promise<void> {
    const serverName = client.name;

    if (this.mcpToolsLoaded.has(serverName)) {
      return;
    }

    const mcpTools = await client.listTools();

    for (const tool of mcpTools) {
      const namespacedName = `mcp__${serverName}__${tool.name}`;

      this.tools.set(namespacedName, {
        name: namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: "mcp",
        mcpServer: serverName,
        originalName: tool.name,
      });
    }

    this.mcpToolsLoaded.add(serverName);
    this.mcpClients.set(serverName, client);

    console.log(`[ToolRegistry] Loaded ${mcpTools.length} tools from MCP server: ${serverName}`);
  }

  /**
   * Pre-load tool schemas from all registered MCP servers.
   * This builds the tool list for the LLM without maintaining connections.
   */
  async preloadMcpSchemas(): Promise<void> {
    if (!this.mcpClientFactory) {
      console.warn("[ToolRegistry] No MCP client factory set, skipping MCP preload");
      return;
    }

    for (const [serverName, config] of this.mcpConfigs) {
      if (this.mcpToolsLoaded.has(serverName)) {
        continue;
      }

      try {
        const client = this.mcpClientFactory(config);
        await client.connect();
        await this.loadMcpTools(client);
        // Disconnect after loading schemas - will reconnect on-demand
        await client.disconnect();
        this.mcpClients.delete(serverName);
      } catch (error) {
        console.warn(
          `[ToolRegistry] Failed to load tools from ${serverName}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ToolAdapter Interface Implementation
  // ---------------------------------------------------------------------------

  /**
   * Get all registered tools in Anthropic tool format.
   */
  async getTools(): Promise<ToolDefinition[]> {
    // Ensure MCP tools are loaded
    await this.preloadMcpSchemas();

    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * Execute a tool by name.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        isError: true,
        content: `Unknown tool: ${name}`,
      };
    }

    try {
      if (tool.source === "agent") {
        // Execute agent tool
        const agentTool = this.agentTools.get(name);
        if (!agentTool) {
          return {
            isError: true,
            content: `Agent tool not found: ${name}`,
          };
        }
        const result = await agentTool.execute(args, context);
        return {
          isError: false,
          content: result,
        };
      } else {
        // Execute MCP tool
        const parsed = this.parseMcpToolName(name);
        if (!parsed) {
          return {
            isError: true,
            content: `Invalid MCP tool name: ${name}`,
          };
        }

        const client = await this.getMcpClient(parsed.server);
        const result = await client.callTool(parsed.tool, args);

        return {
          isError: result.isError,
          content: result.content,
        };
      }
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Clean up MCP connections.
   */
  async cleanup(): Promise<void> {
    console.log(`[ToolRegistry] Cleaning up ${this.mcpClients.size} MCP connections`);
    for (const client of this.mcpClients.values()) {
      try {
        await client.disconnect();
      } catch (err) {
        console.warn("[ToolRegistry] Failed to disconnect MCP client:", err);
      }
    }
    this.mcpClients.clear();
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Get a specific tool by name.
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is an MCP tool.
   */
  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /**
   * Parse MCP tool name to extract server and tool name.
   */
  parseMcpToolName(name: string): { server: string; tool: string } | null {
    const match = name.match(/^mcp__([^_]+)__(.+)$/);
    if (!match) {
      return null;
    }
    return { server: match[1], tool: match[2] };
  }

  /**
   * Get MCP server config by name.
   */
  getMcpConfig(serverName: string): MCPServerConfig | undefined {
    return this.mcpConfigs.get(serverName);
  }

  /**
   * Get or create MCP client for a server (lazy connection).
   */
  private async getMcpClient(serverName: string): Promise<MCPClient> {
    // Check if already connected
    let client = this.mcpClients.get(serverName);
    if (client && client.isConnected()) {
      return client;
    }

    // Get config and create new client
    const config = this.mcpConfigs.get(serverName);
    if (!config) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    if (!this.mcpClientFactory) {
      throw new Error("No MCP client factory set");
    }

    console.log(`[ToolRegistry] Connecting to MCP server on-demand: ${serverName}`);
    client = this.mcpClientFactory(config);
    await client.connect();
    this.mcpClients.set(serverName, client);

    return client;
  }

  /**
   * Extract JSON schema from a Zod schema or pass through if already JSON schema.
   */
  private extractInputSchema(schema: unknown): Record<string, unknown> {
    // If it looks like a Zod schema (has _def property), convert it
    if (schema && typeof schema === "object" && "_def" in schema) {
      try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { zodToJsonSchema } = require("zod-to-json-schema");
        return zodToJsonSchema(schema) as Record<string, unknown>;
      } catch {
        console.warn("[ToolRegistry] Failed to convert Zod schema, using empty schema");
        return { type: "object", properties: {} };
      }
    }

    // Assume it's already a JSON schema
    return (schema as Record<string, unknown>) ?? { type: "object", properties: {} };
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
    this.agentTools.clear();
    this.mcpConfigs.clear();
    this.mcpToolsLoaded.clear();
    // Note: doesn't disconnect clients - caller should handle that via cleanup()
  }
}
