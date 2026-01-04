/**
 * Reactive Agent Handler
 *
 * Lambda handler for reactive agents using the shared @cikada/reactive-agent package.
 * This is a thin wrapper that:
 * - Sets up adapters (DynamoDB storage, API Gateway broadcast, Anthropic LLM)
 * - Configures MCP tools via ToolRegistry
 * - Delegates to runReactiveAgent() from the shared package
 */

import {
  runReactiveAgent,
  ToolRegistry,
  MCPClient,
  convertTymbalHistoryToAnthropic,
  type MCPServerConfig,
  type BroadcastAdapter,
} from "@cikada/reactive-agent";
import { createTymbalFrameHandler } from "@cikada/core";
import { createDynamoDbStorage, type Storage } from "@cikada/storage";
import {
  createDynamoStorageAdapter,
  createAnthropicAdapter,
} from "./adapters/index.js";
import { broadcastToChannel } from "./channel-broadcast.js";

// =============================================================================
// Types
// =============================================================================

export interface ReactiveAgentEvent {
  /** Space ID (tenant) */
  spaceId: string;
  /** Channel ID */
  channelId: string;
  /** Agent's callsign */
  agentCallsign: string;
  /** Agent's instance start time (ISO timestamp, from roster joinedAt) */
  sinceTimestamp: string;
  /** The new user message content to process */
  userMessage: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** MCP server configurations (optional) */
  mcpServers?: MCPServerConfig[];
  /** Model to use (optional, defaults to claude-sonnet-4) */
  model?: string;
  /** Max tokens (optional, defaults to 4096) */
  maxTokens?: number;
}

export interface ReactiveAgentResult {
  /** Final assistant response text */
  response: string;
  /** Number of turns in the agentic loop */
  numTurns: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TURNS = 20;

// =============================================================================
// DynamoDB Storage Singleton
// =============================================================================

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (!_storage) {
    const region = process.env.AWS_REGION || "us-east-1";
    const tableName = process.env.MAIN_TABLE;

    if (!tableName) {
      throw new Error("MAIN_TABLE environment variable not set");
    }

    _storage = createDynamoDbStorage({
      region,
      tableName,
    });
  }
  return _storage;
}

// =============================================================================
// TymbalFrameHandler Broadcast Wrapper
// =============================================================================

/**
 * Create a BroadcastAdapter that routes frames through TymbalFrameHandler.
 *
 * The handler provides:
 * - Persistence of SetFrames to DynamoDB
 * - Field normalization (input → args)
 * - Broadcast to WebSocket clients
 *
 * Known limitations (MVP):
 * - routeMessage is no-op (agent-to-agent routing not supported)
 * - ResetFrame deletion will fail silently (DynamoDB needs channelId)
 */
function createTymbalBroadcastAdapter(
  spaceId: string,
  channelId: string
): BroadcastAdapter {
  const storage = getStorage();

  // Create the TymbalFrameHandler
  const frameHandler = createTymbalFrameHandler({
    storage,
    // Broadcast adapter: handler passes (channelId, frame), we have spaceId in closure
    broadcast: async (_channelId: string, frame: string) => {
      await broadcastToChannel(spaceId, _channelId, frame);
    },
    // No-op for MVP — agent-to-agent routing not supported in AWS yet
    routeMessage: async () => {
      // No-op: @mentions won't trigger other agents in AWS
    },
  });

  // Return a BroadcastAdapter that delegates to the handler
  return {
    async broadcast(frame: string): Promise<void> {
      await frameHandler.handleFrame(spaceId, channelId, frame);
    },
    async hasListeners(): Promise<boolean> {
      // We always process frames for persistence, even without listeners
      return true;
    },
  };
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Run a reactive agent turn.
 *
 * This is the main entry point for Lambda. It:
 * 1. Creates adapters from environment configuration
 * 2. Sets up the tool registry with MCP servers
 * 3. Delegates to runReactiveAgent() from the shared package
 */
export async function runReactiveAgentHandler(
  event: ReactiveAgentEvent
): Promise<ReactiveAgentResult> {
  const {
    spaceId,
    channelId,
    agentCallsign,
    sinceTimestamp,
    userMessage,
    systemPrompt,
    mcpServers = [],
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = event;

  console.log(
    `[ReactiveAgent] Starting for ${agentCallsign} in channel ${channelId}`
  );
  console.log(
    `[ReactiveAgent] MCP servers received: ${mcpServers.length}`,
    mcpServers.map((s) => s.name)
  );

  // Create adapters
  // Note: We use createDynamoStorageAdapter for reactive-agent's StorageAdapter interface
  // and createTymbalBroadcastAdapter wraps TymbalFrameHandler for persistence + broadcast
  const storage = createDynamoStorageAdapter();
  const broadcast = createTymbalBroadcastAdapter(spaceId, channelId);
  const llm = createAnthropicAdapter();

  // Load conversation history from DynamoDB
  // Fallback to epoch if sinceTimestamp not provided (new agent, no roster entry)
  const effectiveSinceTimestamp = sinceTimestamp ?? "1970-01-01T00:00:00.000Z";
  let conversationHistory: Awaited<ReturnType<typeof convertTymbalHistoryToAnthropic>> = [];

  try {
    const storedHistory = await storage.getAgentHistory(spaceId, channelId, {
      agentCallsign,
      sinceTimestamp: effectiveSinceTimestamp,
    });
    conversationHistory = convertTymbalHistoryToAnthropic(storedHistory);

    console.log(
      `[ReactiveAgent] Loaded ${storedHistory.length} messages, converted to ${conversationHistory.length} LLM messages`
    );
  } catch (historyError) {
    console.error("[ReactiveAgent] Failed to load history, starting fresh:", historyError);
    // Continue with empty history
  }

  // Set up tool registry with MCP servers
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMcpServers(mcpServers);
  toolRegistry.setMcpClientFactory((config) => new MCPClient(config));

  // Log tool registry state for CloudWatch verification
  const tools = await toolRegistry.getTools();
  console.log(
    `[ReactiveAgent] Tool registry populated: ${tools.length} tools`,
    tools.slice(0, 10).map((t) => t.name)
  );

  try {
    // Run the shared reactive agent implementation
    const result = await runReactiveAgent({
      spaceId,
      channelId,
      agentCallsign,
      userMessage,
      systemPrompt,
      conversationHistory,
      broadcast,
      llm,
      tools: toolRegistry,
      model,
      maxTokens,
      maxTurns: MAX_TURNS,
    });

    console.log(
      `[ReactiveAgent] Completed in ${result.durationMs}ms, ${result.numTurns} turns`
    );

    return {
      response: result.response,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
    };
  } finally {
    // Clean up MCP connections
    await toolRegistry.cleanup();
  }
}

/**
 * Create Lambda handler for reactive agent.
 */
export function createReactiveAgentHandler() {
  return async (event: ReactiveAgentEvent): Promise<ReactiveAgentResult> => {
    return runReactiveAgentHandler(event);
  };
}

// For backwards compatibility, export the handler function with original name
export { runReactiveAgentHandler as runReactiveAgent };
