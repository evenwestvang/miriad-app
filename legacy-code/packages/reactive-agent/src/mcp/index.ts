/**
 * MCP Module
 *
 * MCP client and tool registry for connecting to MCP servers.
 */

export { MCPClient } from "./mcp-client.js";
export type { MCPServerConfig, MCPTool, MCPToolResult } from "./mcp-client.js";

export { ToolRegistry } from "./tool-registry.js";
export type { RegisteredTool, AgentToolDefinition } from "./tool-registry.js";
