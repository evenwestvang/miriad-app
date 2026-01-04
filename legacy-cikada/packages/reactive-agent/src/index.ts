/**
 * @cikada/reactive-agent
 *
 * Platform-agnostic reactive agent core for Cikada.
 *
 * This package provides the shared implementation for reactive agents
 * that runs on both local development and AWS Lambda deployments.
 *
 * Usage:
 * ```ts
 * import { runReactiveAgent, ToolRegistry, MCPClient } from '@cikada/reactive-agent';
 *
 * // Create adapters for your platform
 * const storage = createYourStorageAdapter();
 * const broadcast = createYourBroadcastAdapter();
 * const llm = createYourLLMAdapter();
 *
 * // Optionally set up tools via MCP
 * const toolRegistry = new ToolRegistry();
 * toolRegistry.registerMcpServers([{ name: 'board', transport: 'http', url: '...' }]);
 * toolRegistry.setMcpClientFactory((config) => new MCPClient(config));
 *
 * // Run the agent
 * const result = await runReactiveAgent({
 *   spaceId: 'space-123',
 *   channelId: 'channel-456',
 *   agentCallsign: 'fox',
 *   userMessage: 'Hello!',
 *   systemPrompt: 'You are a helpful assistant.',
 *   conversationHistory: [], // Pre-loaded history from caller
 *   storage,
 *   broadcast,
 *   llm,
 *   tools: toolRegistry,
 * });
 * ```
 */

// Core types
export type {
  ReactiveAgentConfig,
  ReactiveAgentResult,
  ToolCall,
  StepResult,
} from "./types.js";

// Main entry point
export { runReactiveAgent } from "./reactive-loop.js";

// Adapter interfaces
export type {
  StorageAdapter,
  GetAgentHistoryOptions,
  MessageToSave,
} from "./adapters/storage.js";

export type { BroadcastAdapter, BroadcastAdapterFactory } from "./adapters/broadcast.js";
export { createNoOpBroadcastAdapter } from "./adapters/broadcast.js";

export type {
  LLMAdapter,
  LLMStreamParams,
  LLMMessage,
  LLMContentBlock,
  StreamChunk,
  StopReason,
  ToolDefinition,
} from "./adapters/llm.js";

export type {
  ToolAdapter,
  ToolExecutionContext,
  ToolResult,
} from "./adapters/tools.js";
export { createNoOpToolAdapter } from "./adapters/tools.js";

// MCP support
export { MCPClient } from "./mcp/mcp-client.js";
export type { MCPServerConfig, MCPTool, MCPToolResult } from "./mcp/mcp-client.js";

export { ToolRegistry } from "./mcp/tool-registry.js";
export type { RegisteredTool, AgentToolDefinition } from "./mcp/tool-registry.js";

// Tymbal helpers - re-exported from @cikada/core
export {
  tymbal,
  createMessageHandle,
  generateMessageId,
} from "@cikada/core/tymbal";
export type {
  TymbalFrame,
  StartFrame,
  AppendFrame,
  SetFrame,
  ResetFrame as DeleteFrame,
  MessageHandle,
  MessageHandleOptions,
} from "@cikada/core/tymbal";

// History utilities
export {
  convertHistoryToMessages,
  mergeToolResultsWithUser,
  convertTymbalHistoryToAnthropic,
} from "./history.js";
export type { TymbalStoredMessage } from "./history.js";
