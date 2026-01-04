import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  Context,
  ProcessDefinition,
  FlowEvent,
  GenerateResult,
  Message,
  MessageHandle,
  StepOptions,
  StepResult,
  ToolCall,
  ToolResult,
  SentMessage,
  AgentMessage,
} from "@cikada/agent";
import { tymbal, generateMessageId, createMessageHandle } from "@cikada/core/tymbal";
import { storage, type StoredMessage } from "./storage.js";

// =============================================================================
// Types
// =============================================================================

export interface DriverOptions {
  anthropic: Anthropic;
  model?: string;
}

export interface RunOptions {
  threadId: string;
  agentName: string;
  userMessage: string;
  agent: ProcessDefinition;
  broadcast: (frame: string) => Promise<void>;
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
// Driver Implementation
// =============================================================================

export function createDriver(options: DriverOptions) {
  const { anthropic, model: defaultModel = DEFAULT_MODEL } = options;

  /**
   * Run the process (agent or workflow) for a user message.
   */
  async function run(runOptions: RunOptions): Promise<void> {
    const { threadId, agentName, agent: process, userMessage, broadcast } = runOptions;
    const model = process.config?.model ?? defaultModel;

    console.log(`[Driver] Running ${process.kind} for thread ${threadId}, model: ${model}`);

    // Update thread status
    await storage.updateThreadStatus(threadId, "running");

    try {
      // Note: User message is already saved and broadcast by the server
      // before invoking the driver. This ensures 200 = message stored.

      // Build context for the process
      const ctx = createContext({
        threadId,
        agentName,
        process,
        model,
        broadcast,
        anthropic,
      });

      // Run the appropriate handler based on kind
      if (process.kind === "workflow") {
        // Workflow mode - call onFlow once, returns result on completion
        console.log(`[Driver] Starting workflow (onFlow mode)...`);
        const result = await process.onFlow(ctx);
        console.log(`[Driver] Workflow completed with result:`, result);

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
        // Agent with onEvent mode - call handler for each event
        console.log(`[Driver] Running agent (onEvent mode)...`);
        // For local runtime, just handle the single message
        await process.onEvent({ type: "message", content: userMessage }, ctx);
        console.log(`[Driver] onEvent handler complete`);
        await storage.updateThreadStatus(threadId, "idle");
      } else {
        // Default mode - run the agentic loop
        console.log(`[Driver] Starting agentic loop...`);
        await ctx.llm.generate(userMessage);
        console.log(`[Driver] Agentic loop complete`);
        await storage.updateThreadStatus(threadId, "idle");
      }
    } catch (error) {
      // Handle completion signal
      if (error instanceof CompletionSignal) {
        console.log(`[Driver] Process completed with result:`, error.result);
        await storage.updateThreadStatus(threadId, "completed");
        return;
      }

      await storage.updateThreadStatus(threadId, "error");

      // Send error message
      const errorMsgId = generateMessageId();
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await broadcast(
        tymbal.set(errorMsgId, {
          type: "error",
          content: `Error: ${errorMessage}`,
        })
      );

      throw error;
    }
  }

  return { run };
}

// =============================================================================
// Context Factory
// =============================================================================

interface ContextOptions {
  threadId: string;
  agentName: string;
  process: ProcessDefinition;
  model: string;
  broadcast: (frame: string) => Promise<void>;
  anthropic: Anthropic;
}

function createContext(options: ContextOptions): Context {
  const { threadId, agentName, process, model, broadcast, anthropic } = options;

  // Track pending tool results for the current turn
  const pendingToolResults: Map<string, unknown> = new Map();

  // Track conversation history for this run
  const conversationHistory: Message[] = [];

  // ---------------------------------------------------------------------------
  // Message Building
  // ---------------------------------------------------------------------------

  function buildMessages(userContent?: string): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add history
    for (const msg of conversationHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({
          role: msg.role,
          content: msg.content as string | Anthropic.ContentBlock[],
        });
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
      const toolResultContent: Anthropic.ToolResultBlockParam[] = Array.from(
        pendingToolResults.entries()
      ).map(([callId, result]) => ({
        type: "tool_result" as const,
        tool_use_id: callId,
        content: typeof result === "string" ? result : JSON.stringify(result),
      }));

      messages.push({
        role: "user",
        content: toolResultContent,
      });

      pendingToolResults.clear();
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // Tool Conversion
  // ---------------------------------------------------------------------------

  function buildTools(): Anthropic.Tool[] | undefined {
    if (!process.tools || Object.keys(process.tools).length === 0) {
      return undefined;
    }

    return Object.entries(process.tools).map(([name, def]) => ({
      name,
      description: def.description,
      input_schema: zodToJsonSchema(def.parameters) as Anthropic.Tool.InputSchema,
    }));
  }

  // ---------------------------------------------------------------------------
  // LLM Operations
  // ---------------------------------------------------------------------------

  async function generateStep(
    content?: string,
    opts?: StepOptions
  ): Promise<StepResult> {
    console.log(`[Driver] generateStep called, content: ${content?.slice(0, 50)}...`);
    const messages = buildMessages(content);
    const tools = buildTools();
    console.log(`[Driver] Calling Anthropic with ${messages.length} messages, model: ${model}`);

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

    // Call Anthropic with streaming
    const stream = anthropic.messages.stream({
      model,
      max_tokens: opts?.maxTokens ?? process.config?.maxTokens ?? 4096,
      system: process.system,
      messages,
      tools,
    });

    // Process stream events
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          fullText += event.delta.text;
          await msgHandle.stream(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          // Tool input streaming - we'll handle the full tool call at the end
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          // Tool use block started
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason === "tool_use") {
          stopReason = "tool_use";
        } else if (event.delta.stop_reason === "max_tokens") {
          stopReason = "max_tokens";
        }
      }
    }

    // Get final message for tool calls
    const finalMessage = await stream.finalMessage();

    // Extract tool calls from final message
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
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
    const assistantContent: Anthropic.ContentBlock[] = [];
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
      // Execute all tool calls in parallel
      await Promise.all(response.toolCalls.map((call) => executeTool(call)));

      // Continue the loop
      response = await generateStep();
    }

    return {
      text: response.text,
      toolCalls:
        response.toolCalls.length > 0 ? response.toolCalls : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Execution
  // ---------------------------------------------------------------------------

  async function executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = process.tools?.[call.name];

    if (!tool) {
      const result: ToolResult = {
        callId: call.id,
        result: { error: `Unknown tool: ${call.name}` },
        isError: true,
      };
      pendingToolResults.set(call.id, result.result);
      return result;
    }

    try {
      // Execute the tool
      const result = await tool.execute(call.args, ctx);

      // Store result for next LLM call
      pendingToolResults.set(call.id, result);

      // Broadcast tool result
      const toolMsgId = generateMessageId();
      await broadcast(
        tymbal.set(toolMsgId, {
          type: "tool_result",
          toolName: call.name,
          callId: call.id,
          content: result,
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
          content: result,
          sender: agentName,
        },
        timestamp: new Date().toISOString(),
        isComplete: true,
      });

      return {
        callId: call.id,
        result,
        isError: false,
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
      throw new Error("events.next() is not supported in local runtime");
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error("events iteration is not supported in local runtime");
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
  // Stub implementations for Lambda Durable features
  // ---------------------------------------------------------------------------

  async function spawn(): Promise<never> {
    throw new Error("spawn() is not supported in local runtime");
  }

  function onTerminate(_handler: () => Promise<unknown>): void {
    // No-op in local runtime - termination not supported
    console.log("[Driver] onTerminate registered (not supported in local runtime)");
  }

  async function sendTo(_targetThreadId: string, _payload: unknown): Promise<SentMessage> {
    throw new Error("sendTo() is not supported in local runtime");
  }

  async function reply(_message: AgentMessage, _payload: unknown): Promise<SentMessage> {
    throw new Error("reply() is not supported in local runtime");
  }

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // For local runtime, just execute the function (no durability)
    return fn();
  }

  async function parallel<T extends readonly unknown[]>(
    _name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    // Execute in parallel (no durability)
    const results = await Promise.all(fns.map((fn) => fn()));
    return results as unknown as T;
  }

  async function map<T, R>(
    _name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    _opts?: { maxConcurrency?: number }
  ): Promise<R[]> {
    // Execute in parallel (no concurrency control in local mode)
    return Promise.all(items.map((item, index) => fn(item, index)));
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
