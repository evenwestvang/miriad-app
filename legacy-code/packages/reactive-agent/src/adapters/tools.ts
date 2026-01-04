/**
 * Tool Adapter Interface
 *
 * Abstracts tool discovery and execution for the reactive agent.
 * Implementations: MCP-based (via ToolRegistry), Direct (static tools).
 */

import type { ToolDefinition } from "./llm.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Context passed to tool execution.
 */
export interface ToolExecutionContext {
  /** Space ID */
  spaceId: string;
  /** Channel ID */
  channelId: string;
  /** Agent callsign */
  agentCallsign: string;
  /** Additional context that tools might need */
  [key: string]: unknown;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether the tool execution resulted in an error */
  isError: boolean;
  /** The result content (string or structured data) */
  content: unknown;
}

// =============================================================================
// Tool Adapter Interface
// =============================================================================

/**
 * Tool adapter interface for the reactive agent.
 *
 * Implementations:
 * - MCP: Tools from MCP servers (board tools, user-configured servers)
 * - Static: Pre-defined tools (for simple agents)
 * - Composite: Merges multiple tool sources
 */
export interface ToolAdapter {
  /**
   * Get all available tool definitions.
   * Called once at the start of each turn to build the tool list for the LLM.
   */
  getTools(): Promise<ToolDefinition[]>;

  /**
   * Execute a tool by name.
   * @param name - Tool name (may include namespace for MCP tools: mcp__server__tool)
   * @param args - Tool arguments
   * @param context - Execution context
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult>;

  /**
   * Clean up any resources (e.g., disconnect MCP clients).
   */
  cleanup?(): Promise<void>;
}

/**
 * Create a no-op tool adapter (no tools available).
 */
export function createNoOpToolAdapter(): ToolAdapter {
  return {
    async getTools(): Promise<ToolDefinition[]> {
      return [];
    },
    async execute(name: string): Promise<ToolResult> {
      return {
        isError: true,
        content: `Unknown tool: ${name}`,
      };
    },
  };
}
