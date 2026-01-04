/**
 * Durable Driver
 *
 * Creates a driver that wraps LLM calls and tool executions in durable steps.
 * Enables recovery from crashes by checkpointing each significant operation.
 *
 * Key differences from regular driver:
 * - LLM calls wrapped in ctx.step() for checkpointing
 * - Tool executions tracked in durable context
 * - Supports pluggable LLM adapter (for testing with MockLLMAdapter)
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
import { zodToJsonSchema } from "zod-to-json-schema";
import { tymbal, generateMessageId, createMessageHandle } from "@cikada/core/tymbal";
import { storage } from "../storage.js";
import type { DurableContext } from "./durable-context.js";
import type { LLMAdapter, StreamChunk, ToolDefinition } from "../testing/mock-llm.js";

// =============================================================================
// Types
// =============================================================================

export interface DurableDriverOptions {
  /** LLM adapter (real Anthropic or mock) */
  llm: LLMAdapter;
  /** Durable context for checkpointing */
  durableContext: DurableContext;
  /** Default model to use */
  model?: string;
}

export interface DurableRunOptions {
  /** Thread identifier */
  threadId: string;
  /** Agent name */
  agentName: string;
  /** User message to process */
  userMessage: string;
  /** Agent/workflow definition */
  agent: ProcessDefinition;
  /** Broadcast function for streaming frames */
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
// Durable Driver Factory
// =============================================================================

export function createDurableDriver(options: DurableDriverOptions) {
  const { llm, durableContext, model: defaultModel = DEFAULT_MODEL } = options;

  /**
   * Run the process (agent or workflow) with durable execution.
   */
  async function run(runOptions: DurableRunOptions): Promise<void> {
    const { threadId, agentName, agent: process, userMessage, broadcast } = runOptions;
    const model = process.config?.model ?? defaultModel;

    console.log(`[DurableDriver] Running ${process.kind} for thread ${threadId}, model: ${model}`);

    // Update thread status
    await storage.updateThreadStatus(threadId, "running");

    try {
      // Build context for the process
      const ctx = createDurableContextWrapper({
        threadId,
        agentName,
        process,
        model,
        broadcast,
        llm,
        durableContext,
      });

      // Run the appropriate handler based on kind
      if (process.kind === "workflow") {
        // Workflow mode - call onFlow once
        console.log(`[DurableDriver] Starting workflow (onFlow mode)...`);
        const result = await process.onFlow(ctx);
        console.log(`[DurableDriver] Workflow completed with result:`, result);

        // Mark durable execution as complete
        await durableContext.complete(result);

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
        // Agent with onEvent mode
        console.log(`[DurableDriver] Running agent (onEvent mode)...`);
        await process.onEvent({ type: "message", content: userMessage }, ctx);
        console.log(`[DurableDriver] onEvent handler complete`);
        await storage.updateThreadStatus(threadId, "idle");
      } else {
        // Default mode - run the agentic loop
        console.log(`[DurableDriver] Starting agentic loop...`);
        await ctx.llm.generate(userMessage);
        console.log(`[DurableDriver] Agentic loop complete`);
        await storage.updateThreadStatus(threadId, "idle");
      }
    } catch (error) {
      // Handle completion signal
      if (error instanceof CompletionSignal) {
        console.log(`[DurableDriver] Process completed with result:`, error.result);
        await storage.updateThreadStatus(threadId, "completed");
        return;
      }

      // Mark durable execution as error
      if (error instanceof Error) {
        await durableContext.markError(error);
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
    }
  }

  return { run };
}

// =============================================================================
// Context Factory
// =============================================================================

interface DurableContextWrapperOptions {
  threadId: string;
  agentName: string;
  process: ProcessDefinition;
  model: string;
  broadcast: (frame: string) => Promise<void>;
  llm: LLMAdapter;
  durableContext: DurableContext;
}

function createDurableContextWrapper(options: DurableContextWrapperOptions): Context {
  const { threadId, agentName, process, model, broadcast, llm, durableContext } = options;

  // Track pending tool results for the current turn
  const pendingToolResults: Map<string, unknown> = new Map();

  // Track conversation history
  const conversationHistory: Message[] = [];

  // Step counter for unique step names
  let stepCounter = 0;

  // ---------------------------------------------------------------------------
  // Tool Conversion
  // ---------------------------------------------------------------------------

  function buildTools(): ToolDefinition[] | undefined {
    if (!process.tools || Object.keys(process.tools).length === 0) {
      return undefined;
    }

    return Object.entries(process.tools).map(([name, def]) => ({
      name,
      description: def.description,
      input_schema: zodToJsonSchema(def.parameters),
    }));
  }

  // ---------------------------------------------------------------------------
  // LLM Operations (wrapped in durable steps)
  // ---------------------------------------------------------------------------

  async function generateStep(content?: string): Promise<StepResult> {
    const stepName = `llm-step-${++stepCounter}`;

    // Wrap the LLM call in a durable step
    return durableContext.step(stepName, async () => {
      console.log(`[DurableDriver] generateStep called, content: ${content?.slice(0, 50)}...`);

      // Build messages including history and pending tool results
      const messages = buildMessages(content);
      const tools = buildTools();

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
    });
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
      await Promise.all(response.toolCalls.map((call) => executeTool(call)));

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
  // Tool Execution (wrapped in durable steps)
  // ---------------------------------------------------------------------------

  async function executeTool(call: ToolCall): Promise<ToolResult> {
    const stepName = `tool-${call.name}-${call.id}`;

    return durableContext.step(stepName, async () => {
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
    });
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
      throw new Error("events.next() is not supported in durable driver");
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error("events iteration is not supported in durable driver");
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  async function complete(result?: unknown): Promise<void> {
    // Mark durable execution as complete
    await durableContext.complete(result);

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
  // Durable Primitives (delegate to durableContext)
  // ---------------------------------------------------------------------------

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return durableContext.step(name, fn);
  }

  async function parallel<T extends readonly unknown[]>(
    name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    return durableContext.parallel(name, fns);
  }

  async function map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: { maxConcurrency?: number }
  ): Promise<R[]> {
    return durableContext.map(name, items, fn, opts);
  }

  // ---------------------------------------------------------------------------
  // Stub implementations for advanced features
  // ---------------------------------------------------------------------------

  async function spawn(): Promise<never> {
    throw new Error("spawn() is not supported in durable driver");
  }

  function onTerminate(_handler: () => Promise<unknown>): void {
    console.log("[DurableDriver] onTerminate registered (not fully supported)");
  }

  async function sendTo(_targetThreadId: string, _payload: unknown): Promise<SentMessage> {
    throw new Error("sendTo() is not supported in durable driver");
  }

  async function reply(_message: AgentMessage, _payload: unknown): Promise<SentMessage> {
    throw new Error("reply() is not supported in durable driver");
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
