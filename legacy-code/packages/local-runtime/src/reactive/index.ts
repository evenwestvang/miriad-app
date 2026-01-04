/**
 * Reactive Driver
 *
 * Native MCP integration for Cikada agents.
 * Provides full tool ecosystem support without Docker overhead.
 */

// Re-export MCP and tool types from shared package
export {
  MCPClient,
  ToolRegistry,
  type MCPServerConfig,
  type MCPTool,
  type MCPToolResult,
  type RegisteredTool,
  type AgentToolDefinition,
} from "@cikada/reactive-agent";

// Re-export ToolExecutionContext from adapters
export type { ToolExecutionContext } from "@cikada/reactive-agent";

// Local reactive driver
export {
  createReactiveDriver,
  type ReactiveDriverOptions,
  type ReactiveRunOptions,
} from "./reactive-driver.js";
