/**
 * Reactive Driver
 *
 * Stateless driver that provides native MCP tool support for agents.
 * Each turn is independent - history is loaded from storage, not checkpointed.
 *
 * Key features:
 * - Connects to MCP servers lazily (on first tool invocation)
 * - Merges MCP tools with agent-defined tools
 * - Streams responses via Tymbal
 * - No durable execution overhead - clean request/response per turn
 *
 * For the default agentic loop mode, delegates to @cikada/reactive-agent's
 * runReactiveAgent() for shared implementation with AWS Lambda.
 */

import type {
  ProcessDefinition,
  Context,
  Message,
  ToolCall,
  ToolResult,
  GenerateResult,
  StepResult,
  FlowEvent,
  MessageHandle,
  SentMessage,
  AgentMessage,
} from "@cikada/agent";
import {
  runReactiveAgent,
  ToolRegistry,
  MCPClient,
  type MCPServerConfig,
  type AgentToolDefinition,
} from "@cikada/reactive-agent";
import { tymbal, generateMessageId, createMessageHandle } from "@cikada/core/tymbal";
import { storage } from "../storage.js";
import {
  createLocalBroadcastAdapter,
  createAnthropicAdapterFromClient,
} from "../adapters/index.js";
import type { LLMAdapter, StreamChunk, ToolDefinition } from "../testing/mock-llm.js";

// =============================================================================
// Types
// =============================================================================

export interface ReactiveDriverOptions {
  /** LLM adapter (real Anthropic or mock) */
  llm: LLMAdapter;
  /** MCP server configurations */
  mcpServers?: MCPServerConfig[];
  /** Default model to use */
  model?: string;
  /** Pre-loaded conversation history (optional) */
  conversationHistory?: Message[];
}

export interface ReactiveRunOptions {
  /** Thread identifier (used as channelId for shared package) */
  threadId: string;
  /** Agent name for display purposes */
  agentName: string;
  /** User message to process */
  userMessage: string;
  /** Agent/workflow definition */
  agent: ProcessDefinition;
  /** Broadcast function for streaming frames */
  broadcast: (frame: string) => Promise<void>;
  /** Space ID for storage queries (required for server mode) */
  spaceId?: string;
  /** Channel ID for storage queries (required for server mode) */
  channelId?: string;
  /** Agent's callsign for storage queries - lowercase ID (required for server mode) */
  callsign?: string;
}

/**
 * Special error class to signal workflow/agent completion.
 */
class CompletionSignal extends Error {
  constructor(public readonly result: unknown) {
    super("Completion signal");
    this.name = "CompletionSignal";
  }
}

// =============================================================================
// Default Model
// =============================================================================

const DEFAULT_MODEL = "claude-3-5-haiku-latest";

// =============================================================================
// Reactive Driver Factory
// =============================================================================

export function createReactiveDriver(options: ReactiveDriverOptions) {
  const {
    llm,
    mcpServers = [],
    model: defaultModel = DEFAULT_MODEL,
    conversationHistory: initialHistory = [],
  } = options;

  /**
   * Run the process (agent or workflow) with reactive execution.
   */
  async function run(runOptions: ReactiveRunOptions): Promise<void> {
    const { threadId, agentName, agent: process, userMessage, broadcast, spaceId, channelId, callsign } = runOptions;
    const model = process.config?.model ?? defaultModel;

    console.log(`[ReactiveDriver] Running ${process.kind} for thread ${threadId}, model: ${model}`);

    // Update thread status
    await storage.updateThreadStatus(threadId, "running");

    // Track active MCP clients for cleanup
    const activeMcpClients = new Map<string, MCPClient>();

    // Build tool registry using shared implementation
    const toolRegistry = new ToolRegistry();

    try {

      // Register agent tools (for workflow/onEvent modes that use the Context wrapper)
      // Note: Agent tools expect full Context but we're registering them with the shared ToolRegistry.
      // This works because Context has all properties of ToolExecutionContext plus more.
      if (process.tools) {
        toolRegistry.registerAgentTools(
          process.tools as unknown as Record<string, AgentToolDefinition>
        );
      }

      // Register MCP server configs (tools loaded lazily)
      toolRegistry.registerMcpServers(mcpServers);

      // Set up MCP client factory
      toolRegistry.setMcpClientFactory((config) => new MCPClient(config));

      // Run the appropriate handler based on kind
      if (process.kind === "workflow") {
        // Workflow mode - needs full Context wrapper
        console.log(`[ReactiveDriver] Starting workflow (onFlow mode)...`);

        const ctx = createReactiveContextWrapper({
          threadId,
          agentName,
          process,
          model,
          broadcast,
          llm,
          toolRegistry,
          activeMcpClients,
          initialHistory,
        });

        const result = await process.onFlow(ctx);
        console.log(`[ReactiveDriver] Workflow completed with result:`, result);

        // Persist thread_complete message
        const completeMsgId = generateMessageId();
        await broadcast(tymbal.set(completeMsgId, { type: "thread_complete", result }));
        await storage.saveMessage({
          id: completeMsgId,
          threadId,
          value: { type: "thread_complete", result },
          timestamp: new Date().toISOString(),
          isComplete: true,
        });

        await storage.updateThreadStatus(threadId, "completed");
      } else if (process.kind === "agent" && process.onEvent) {
        // Agent with onEvent mode - needs full Context wrapper
        console.log(`[ReactiveDriver] Running agent (onEvent mode)...`);

        const ctx = createReactiveContextWrapper({
          threadId,
          agentName,
          process,
          model,
          broadcast,
          llm,
          toolRegistry,
          activeMcpClients,
          initialHistory,
        });

        await process.onEvent({ type: "message", content: userMessage }, ctx);
        console.log(`[ReactiveDriver] onEvent handler complete`);
        await storage.updateThreadStatus(threadId, "idle");
      } else {
        // Default mode - use shared runReactiveAgent()
        console.log(`[ReactiveDriver] Starting agentic loop (shared implementation)...`);

        // Create broadcast adapter for the shared package
        // Note: Persistence is handled server-side when Tymbal frames are received
        const broadcastAdapter = createLocalBroadcastAdapter(broadcast);

        // Run using the shared reactive agent implementation
        // Use passed parameters from server, or fall back to local defaults
        const result = await runReactiveAgent({
          spaceId: spaceId ?? "default",
          channelId: channelId ?? threadId,
          agentCallsign: callsign ?? agentName,
          userMessage,
          systemPrompt: process.system,
          conversationHistory: initialHistory as any[], // Pre-loaded history from caller
          broadcast: broadcastAdapter,
          llm: llm as any, // The interface is compatible
          tools: toolRegistry,
          model,
          maxTokens: process.config?.maxTokens ?? 4096,
          maxTurns: 20,
        });

        console.log(`[ReactiveDriver] Agentic loop complete: ${result.numTurns} turns, ${result.durationMs}ms`);
        await storage.updateThreadStatus(threadId, "idle");
      }
    } catch (error) {
      // Handle completion signal
      if (error instanceof CompletionSignal) {
        console.log(`[ReactiveDriver] Process completed with result:`, error.result);
        await storage.updateThreadStatus(threadId, "completed");
        return;
      }

      await storage.updateThreadStatus(threadId, "error");

      // Send error message
      const errorMsgId = generateMessageId();
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await broadcast(
        tymbal.set(errorMsgId, {
          type: "error",
          content: `Error: ${errorMessage}`,
        })
      );

      throw error;
    } finally {
      // Clean up tool registry (which manages MCP connections)
      await toolRegistry.cleanup();
    }
  }

  return { run };
}

// =============================================================================
// Context Factory (for workflow/onEvent modes)
// =============================================================================

interface ReactiveContextWrapperOptions {
  threadId: string;
  agentName: string;
  process: ProcessDefinition;
  model: string;
  broadcast: (frame: string) => Promise<void>;
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  activeMcpClients: Map<string, MCPClient>;
  initialHistory: Message[];
}

function createReactiveContextWrapper(options: ReactiveContextWrapperOptions): Context {
  const {
    threadId,
    agentName,
    process,
    model,
    broadcast,
    llm,
    toolRegistry,
    activeMcpClients,
    initialHistory,
  } = options;

  // Track pending tool results for the current turn
  const pendingToolResults: Map<string, unknown> = new Map();

  // Track conversation history - start with pre-loaded history
  const conversationHistory: Message[] = [...initialHistory];

  // ---------------------------------------------------------------------------
  // MCP Client Management (lazy connection)
  // ---------------------------------------------------------------------------

  async function getMcpClient(serverName: string): Promise<MCPClient> {
    // Check if already connected
    let client = activeMcpClients.get(serverName);
    if (client && client.isConnected()) {
      return client;
    }

    // Get config and create new client
    const config = toolRegistry.getMcpConfig(serverName);
    if (!config) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    console.log(`[ReactiveDriver] Connecting to MCP server on-demand: ${serverName}`);
    client = new MCPClient(config);
    await client.connect();
    activeMcpClients.set(serverName, client);

    return client;
  }

  // ---------------------------------------------------------------------------
  // Tool Conversion
  // ---------------------------------------------------------------------------

  async function buildTools(): Promise<ToolDefinition[] | undefined> {
    const allTools = await toolRegistry.getTools();
    if (allTools.length === 0) {
      return undefined;
    }
    return allTools as ToolDefinition[];
  }

  // ---------------------------------------------------------------------------
  // LLM Operations
  // ---------------------------------------------------------------------------

  async function generateStep(content?: string): Promise<StepResult> {
    console.log(`[ReactiveDriver] generateStep called, content: ${content?.slice(0, 50)}...`);

    // Build messages including history and pending tool results
    const messages = buildMessages(content);
    const tools = await buildTools();

    // Create assistant message handle for streaming
    const msgId = generateMessageId();
    const msgHandle = createMessageHandle({
      id: msgId,
      metadata: { type: "assistant", sender: agentName },
      broadcast,
    });

    let fullText = "";
    const toolCalls: ToolCall[] = [];
    let stopReason: StepResult["stopReason"] = "end_turn";

    // Stream from LLM adapter
    for await (const chunk of llm.stream({
      model,
      system: process.system,
      messages,
      tools,
      max_tokens: process.config?.maxTokens ?? 4096,
    })) {
      if (chunk.type === "text" && chunk.content) {
        fullText += chunk.content;
        await msgHandle.stream(chunk.content);
      } else if (chunk.type === "tool_use" && chunk.toolCall) {
        toolCalls.push({
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: chunk.toolCall.input as Record<string, unknown>,
        });
      } else if (chunk.type === "message_delta" && chunk.stopReason) {
        stopReason = chunk.stopReason;
      }
    }

    // Finalize the message
    await msgHandle.set({ type: "assistant", content: fullText, sender: agentName });

    // Save to storage
    await storage.saveMessage({
      id: msgId,
      threadId,
      value: { type: "assistant", content: fullText, sender: agentName },
      timestamp: new Date().toISOString(),
      isComplete: true,
    });

    // Add to history
    const assistantContent: unknown[] = [];
    if (fullText) {
      assistantContent.push({ type: "text", text: fullText });
    }
    for (const call of toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.args,
      });
    }

    conversationHistory.push({
      role: "assistant",
      content: assistantContent as unknown as string,
    });

    return {
      text: fullText,
      toolCalls,
      stopReason,
    };
  }

  async function generate(content: string): Promise<GenerateResult> {
    // Add user message to history
    conversationHistory.push({
      role: "user",
      content,
    });

    // Full agentic loop - keep calling LLM until no more tool calls
    let response = await generateStep();

    while (response.toolCalls.length > 0) {
      // Execute all tool calls (wrapped in durable steps)
      await Promise.all(response.toolCalls.map((call: ToolCall) => executeTool(call)));

      // Continue the loop
      response = await generateStep();
    }

    return {
      text: response.text,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    };
  }

  function buildMessages(userContent?: string): Message[] {
    const messages: Message[] = [];

    // Add history
    for (const msg of conversationHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push(msg);
      }
    }

    // New user message if provided
    if (userContent) {
      messages.push({
        role: "user",
        content: userContent,
      });
    }

    // Pending tool results
    if (pendingToolResults.size > 0) {
      const toolResultContent = Array.from(pendingToolResults.entries()).map(
        ([callId, result]) => ({
          type: "tool_result" as const,
          tool_use_id: callId,
          content: typeof result === "string" ? result : JSON.stringify(result),
        })
      );

      messages.push({
        role: "user",
        content: toolResultContent as unknown as string,
      });

      pendingToolResults.clear();
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // Tool Execution (with lazy MCP connection)
  // ---------------------------------------------------------------------------

  async function executeTool(call: ToolCall): Promise<ToolResult> {
    try {
      // Execute via tool registry (handles both agent and MCP tools)
      const result = await toolRegistry.execute(call.name, call.args, {
        spaceId: "default",
        channelId: threadId,
        agentCallsign: agentName,
      });

      // Store result for next LLM call
      pendingToolResults.set(call.id, result.content);

      // Broadcast tool result
      const toolMsgId = generateMessageId();
      await broadcast(
        tymbal.set(toolMsgId, {
          type: "tool_result",
          toolName: call.name,
          callId: call.id,
          content: result.content,
          sender: agentName,
        })
      );

      // Save to storage
      await storage.saveMessage({
        id: toolMsgId,
        threadId,
        value: {
          type: "tool_result",
          toolName: call.name,
          callId: call.id,
          content: result.content,
          sender: agentName,
        },
        timestamp: new Date().toISOString(),
        isComplete: true,
      });

      return {
        callId: call.id,
        result: result.content,
        isError: result.isError,
      };
    } catch (err) {
      const errorResult = { error: String(err) };
      pendingToolResults.set(call.id, errorResult);
      return {
        callId: call.id,
        result: errorResult,
        isError: true,
      };
    }
  }

  async function toolResult(callId: string, result: unknown): Promise<void> {
    pendingToolResults.set(callId, result);
  }

  // ---------------------------------------------------------------------------
  // Message Handle
  // ---------------------------------------------------------------------------

  function message(value: Record<string, unknown>): MessageHandle {
    const msgId = generateMessageId();
    return createMessageHandle({
      id: msgId,
      metadata: value,
      broadcast,
    });
  }

  // ---------------------------------------------------------------------------
  // Event Stream (for workflows)
  // ---------------------------------------------------------------------------

  const events: Context["events"] = {
    async next(): Promise<FlowEvent> {
      throw new Error("events.next() is not supported in reactive driver");
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error("events iteration is not supported in reactive driver");
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  async function complete(result?: unknown): Promise<void> {
    // Persist thread_complete message
    const msgId = generateMessageId();
    await broadcast(tymbal.set(msgId, { type: "thread_complete", result }));
    await storage.saveMessage({
      id: msgId,
      threadId,
      value: { type: "thread_complete", result },
      timestamp: new Date().toISOString(),
      isComplete: true,
    });

    // Update thread status
    await storage.updateThreadStatus(threadId, "completed");

    // Throw completion signal to exit the execution loop
    throw new CompletionSignal(result);
  }

  // ---------------------------------------------------------------------------
  // Simple execution helpers (no durability, just run the functions)
  // ---------------------------------------------------------------------------

  async function step<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    // Just execute - no durability needed for stateless chat
    return fn();
  }

  async function parallel<T extends readonly unknown[]>(
    _name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    // Execute in parallel - no durability
    const results = await Promise.all(fns.map((fn) => fn()));
    return results as unknown as T;
  }

  async function map<T, R>(
    _name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: { maxConcurrency?: number }
  ): Promise<R[]> {
    // Execute with optional concurrency control - no durability
    const concurrency = opts?.maxConcurrency ?? Infinity;
    const results: R[] = new Array(items.length);

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, Math.min(i + concurrency, items.length));
      const batchResults = await Promise.all(
        batch.map((item, batchIdx) => fn(item, i + batchIdx))
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Stub implementations for advanced features
  // ---------------------------------------------------------------------------

  async function spawn(): Promise<never> {
    throw new Error("spawn() is not supported in reactive driver");
  }

  function onTerminate(_handler: () => Promise<unknown>): void {
    console.log("[ReactiveDriver] onTerminate registered (not fully supported)");
  }

  async function sendTo(_targetThreadId: string, _payload: unknown): Promise<SentMessage> {
    throw new Error("sendTo() is not supported in reactive driver");
  }

  async function reply(_message: AgentMessage, _payload: unknown): Promise<SentMessage> {
    throw new Error("reply() is not supported in reactive driver");
  }

  // ---------------------------------------------------------------------------
  // Context Object
  // ---------------------------------------------------------------------------

  const ctx: Context = {
    events,
    llm: {
      generate,
      generateStep,
    },
    executeTool,
    toolResult,
    message,
    history: conversationHistory,
    complete,
    onTerminate,
    spawn,
    sendTo,
    reply,
    step,
    parallel,
    map,
    config: process.config ?? {},
    threadId,
  };

  return ctx;
}

// Re-export types from shared package for convenience
export type { MCPServerConfig, AgentToolDefinition };
