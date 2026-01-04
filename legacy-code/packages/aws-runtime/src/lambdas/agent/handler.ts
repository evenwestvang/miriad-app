/**
 * Agent Durable Lambda Handler
 *
 * This is the main agent execution loop. It runs as a Lambda Durable function,
 * allowing it to checkpoint state and wait for user input without consuming
 * compute resources.
 *
 * Supports three execution modes:
 * - Default: Automatic agentic loop (LLM + tools until done)
 * - onEvent: Handler called per event, stateless between
 * - onFlow: Handler called once, controls flow via ctx.events
 */

import type {
  ProcessDefinition,
  Context,
  FlowEvent,
  ToolCall,
  ToolResult,
  Message,
  MessageHandle,
  StepResult,
  StepOptions,
  GenerateResult,
  AgentHandle,
  SentMessage,
  AgentMessage,
} from "@cikada/agent";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getThreadHistory,
  getThreadMeta,
  persistMessage,
  updateThreadMeta,
  createThread,
  addChildThread,
} from "../../shared/db.js";
import { broadcast, hasListeners } from "../../shared/broadcast.js";
import { tymbal } from "@cikada/core/tymbal";
import { generateMessageId, generateUlid } from "../../shared/ulid.js";
import {
  registerProcesses as _registerProcesses,
  getRegisteredProcesses,
  getProcess,
} from "../../shared/registry.js";

// =============================================================================
// Types
// =============================================================================

// Simplified DurableContext interface for our needs
interface DurableContext {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForCallback<T>(
    callbackId: string,
    onWait?: (callbackId: string) => Promise<void>,
    options?: { timeout?: { hours?: number } }
  ): Promise<T>;
  executionContext?: {
    executionArn?: string;
  };
}

// =============================================================================
// Process Registry (Agents + Workflows)
// =============================================================================

/**
 * Register processes for this Lambda. Called during deployment initialization.
 * Re-export from shared registry for backwards compatibility.
 */
export function registerProcesses(processes: Record<string, ProcessDefinition>): void {
  _registerProcesses(processes);
}

// =============================================================================
// Completion Signal
// =============================================================================

/**
 * Special error class to signal workflow/agent completion.
 * Thrown by ctx.complete() to exit the execution loop.
 */
class CompletionSignal extends Error {
  constructor(public readonly result: unknown) {
    super("Completion signal");
    this.name = "CompletionSignal";
  }
}

// =============================================================================
// Message Conversion
// =============================================================================

interface StoredMessageValue {
  type: string;
  content?: unknown;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  callId?: string;
  // Agent messaging fields
  senderId?: string;
  payload?: unknown;
  replyTo?: string;
  agentId?: string;
  result?: unknown;
  error?: unknown;
}

interface StoredMessage {
  msgId: string;
  value: StoredMessageValue;
}

function toClaudeMessages(
  history: StoredMessage[]
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let currentAssistantContent: Anthropic.ContentBlockParam[] = [];

  for (const msg of history) {
    const { type, content } = msg.value;

    if (type === "user") {
      // Flush any pending assistant content
      if (currentAssistantContent.length > 0) {
        messages.push({ role: "assistant", content: currentAssistantContent });
        currentAssistantContent = [];
      }
      messages.push({
        role: "user",
        content: typeof content === "string" ? content : "",
      });
    } else if (type === "assistant") {
      // Only add text blocks if they have content (Claude rejects empty text blocks)
      const text = typeof content === "string" ? content : "";
      if (text.length > 0) {
        currentAssistantContent.push({
          type: "text",
          text,
        });
      }
    } else if (type === "tool_call") {
      currentAssistantContent.push({
        type: "tool_use",
        id: msg.value.id!,
        name: msg.value.name!,
        input: msg.value.args ?? {},
      });
    } else if (type === "tool_result") {
      // Flush assistant content first
      if (currentAssistantContent.length > 0) {
        messages.push({ role: "assistant", content: currentAssistantContent });
        currentAssistantContent = [];
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.value.callId ?? "",
            content:
              typeof content === "string" ? content : JSON.stringify(content),
          },
        ],
      });
    }
  }

  // Flush any remaining assistant content
  if (currentAssistantContent.length > 0) {
    messages.push({ role: "assistant", content: currentAssistantContent });
  }

  return messages;
}

function storedToContextMessages(history: StoredMessage[]): Message[] {
  return history.map((msg) => {
    const { type, content } = msg.value;
    if (type === "user") {
      return { role: "user" as const, content: String(content ?? "") };
    } else if (type === "assistant") {
      return { role: "assistant" as const, content: String(content ?? "") };
    } else if (type === "tool_result") {
      return {
        role: "tool_result" as const,
        content: typeof content === "string" ? content : JSON.stringify(content),
      };
    }
    // Default for unknown types
    return { role: "user" as const, content: JSON.stringify(msg.value) };
  });
}

// =============================================================================
// Tool Conversion
// =============================================================================

function buildTools(process: ProcessDefinition): Anthropic.Tool[] | undefined {
  if (!process.tools || Object.keys(process.tools).length === 0) {
    return undefined;
  }

  return Object.entries(process.tools).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: zodToJsonSchema(def.parameters) as Anthropic.Tool.InputSchema,
  }));
}

// =============================================================================
// Context Implementation
// =============================================================================

interface ContextDeps {
  threadId: string;
  process: ProcessDefinition;
  anthropic: Anthropic;
  durableContext: DurableContext;
  stepPrefix: string;
  input?: unknown;
  getHistory: () => Promise<StoredMessage[]>;
  waitForEvent: () => Promise<FlowEvent>;
}

function createContext(deps: ContextDeps): Context {
  const { threadId, process, anthropic, durableContext, stepPrefix, input, getHistory, waitForEvent } = deps;
  const model = process.config?.model ?? "claude-3-5-haiku-latest";

  // Step counter for unique names
  let stepCounter = 0;
  const nextStep = () => `${stepPrefix}-${stepCounter++}`;

  // Termination handler (set via ctx.onTerminate)
  let terminateHandler: (() => Promise<unknown>) | null = null;

  // Create a MessageHandle for streaming
  function createMessageHandle(msgId: string, initialValue: Record<string, unknown>): MessageHandle {
    return {
      id: msgId,
      async stream(text: string): Promise<void> {
        await broadcast(threadId, tymbal.append(msgId, text));
      },
      async set(value: Record<string, unknown>): Promise<void> {
        await persistMessage(threadId, msgId, value);
        await broadcast(threadId, tymbal.set(msgId, value));
      },
      async delete(): Promise<void> {
        await broadcast(threadId, tymbal.delete(msgId));
      },
    };
  }

  // Execute a tool call
  async function executeToolImpl(call: ToolCall): Promise<ToolResult> {
    const tool = process.tools?.[call.name];
    let result: unknown;

    if (!tool) {
      result = { error: `Unknown tool: ${call.name}` };
    } else {
      result = await durableContext.step(nextStep(), async () => {
        console.log(`Executing tool ${call.name}`);
        return await tool.execute(call.args, ctx);
      });
    }

    return { callId: call.id, result };
  }

  // Generate a single LLM step
  async function generateStepImpl(content?: string, opts?: StepOptions): Promise<StepResult> {
    const history = await getHistory();
    let claudeMessages = toClaudeMessages(history);

    // If content provided, append as user message
    if (content) {
      claudeMessages.push({ role: "user", content });
    }

    // Use custom messages if provided
    if (opts?.messages) {
      claudeMessages = opts.messages.map((m) => ({
        role: m.role === "tool_result" ? "user" : m.role,
        content: m.content,
      })) as Anthropic.MessageParam[];
    }

    // Check for streaming listeners
    const shouldStream = await hasListeners(threadId);
    const msgId = generateMessageId();

    // Broadcast start
    if (shouldStream) {
      await broadcast(threadId, tymbal.start(msgId, { type: "assistant" }));
    }

    // Call Claude
    let text = "";
    const toolCalls: ToolCall[] = [];

    const stream = anthropic.messages.stream({
      model,
      max_tokens: opts?.maxTokens ?? process.config?.maxTokens ?? 4096,
      system: process.system,
      messages: claudeMessages,
      tools: opts?.tools ? buildTools({ ...process, tools: opts.tools }) : buildTools(process),
    });

    // Stream response
    for await (const streamEvent of stream) {
      if (streamEvent.type === "content_block_delta") {
        if (streamEvent.delta.type === "text_delta") {
          text += streamEvent.delta.text;
          if (shouldStream) {
            await broadcast(threadId, tymbal.append(msgId, streamEvent.delta.text));
          }
        }
      }
    }

    // Get final message for tool calls and stop reason
    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    // Persist assistant message if it has text
    if (text.length > 0) {
      await persistMessage(threadId, msgId, { type: "assistant", content: text });
      await broadcast(threadId, tymbal.set(msgId, { type: "assistant", content: text }));
    } else if (shouldStream) {
      // Clean up empty message - delete frame removes the orphaned start frame
      await broadcast(threadId, tymbal.delete(msgId));
    }

    // Persist tool calls
    for (const tc of toolCalls) {
      const tcMsgId = generateMessageId();
      const tcValue = { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
      await persistMessage(threadId, tcMsgId, tcValue);
      await broadcast(threadId, tymbal.set(tcMsgId, tcValue));
    }

    return {
      text,
      toolCalls,
      stopReason: finalMessage.stop_reason === "tool_use"
        ? "tool_use"
        : finalMessage.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn",
    };
  }

  // Full agentic loop
  async function generateImpl(content: string): Promise<GenerateResult> {
    let result = await generateStepImpl(content);

    // Loop while there are tool calls
    while (result.toolCalls.length > 0) {
      // Execute all tool calls
      for (const call of result.toolCalls) {
        const toolResult = await executeToolImpl(call);

        // Persist tool result
        const resultMsgId = generateMessageId();
        const resultValue = { type: "tool_result", callId: call.id, content: toolResult.result };
        await persistMessage(threadId, resultMsgId, resultValue);
        await broadcast(threadId, tymbal.set(resultMsgId, resultValue));
      }

      // Get next response
      result = await generateStepImpl();
    }

    return { text: result.text, toolCalls: result.toolCalls };
  }

  // Report a manual tool result
  async function toolResultImpl(callId: string, result: unknown): Promise<void> {
    const resultMsgId = generateMessageId();
    const resultValue = { type: "tool_result", callId, content: result };
    await persistMessage(threadId, resultMsgId, resultValue);
    await broadcast(threadId, tymbal.set(resultMsgId, resultValue));
  }

  // Create event stream for onFlow
  const eventStream: AsyncIterable<FlowEvent> & { next(): Promise<FlowEvent> } = {
    async next(): Promise<FlowEvent> {
      return await waitForEvent();
    },
    [Symbol.asyncIterator](): AsyncIterator<FlowEvent> {
      return {
        async next(): Promise<IteratorResult<FlowEvent>> {
          const event = await waitForEvent();
          return { value: event, done: false };
        },
      };
    },
  };

  const ctx: Context = {
    events: eventStream,

    llm: {
      generate: generateImpl,
      generateStep: generateStepImpl,
    },

    executeTool: executeToolImpl,
    toolResult: toolResultImpl,

    message(value: Record<string, unknown>): MessageHandle {
      const msgId = generateMessageId();
      // Broadcast start frame
      broadcast(threadId, tymbal.start(msgId, value));
      return createMessageHandle(msgId, value);
    },

    get history(): Message[] {
      // Synchronous access - returns empty, use getHistory() for async
      // This is a limitation - agents should use generateStep with custom messages
      return [];
    },

    async complete(result?: unknown): Promise<void> {
      // Persist thread_complete message with result
      const msgId = generateMessageId();
      const completeValue = { type: "thread_complete", result };
      await persistMessage(threadId, msgId, completeValue);
      await broadcast(threadId, tymbal.set(msgId, completeValue));

      // Update thread status to completed with result
      await updateThreadMeta(threadId, {
        status: "completed",
        result,
        completedAt: new Date().toISOString(),
      });

      // If this thread has a parent, notify the parent
      const meta = await getThreadMeta(threadId);
      if (meta?.parentThreadId) {
        // Persist agent_complete message in parent's thread
        const parentMsgId = generateMessageId();
        const parentCompleteValue = { type: "agent_complete", agentId: threadId, result };
        await persistMessage(meta.parentThreadId, parentMsgId, parentCompleteValue);
        await broadcast(meta.parentThreadId, tymbal.set(parentMsgId, parentCompleteValue));

        // Invoke parent's callback if waiting
        const parentMeta = await getThreadMeta(meta.parentThreadId);
        if (parentMeta?.callbackId) {
          // The callback will be invoked by the runtime when it sees the message
          // For now, we just persist the message - the parent's waitForEvent will pick it up
        }
      }

      // Throw completion signal to exit the execution loop
      throw new CompletionSignal(result);
    },

    onTerminate(handler: () => Promise<unknown>): void {
      // Store the handler - will be called when terminate event is received
      terminateHandler = handler;
    },

    async spawn(agentName: string, spawnInput: unknown): Promise<AgentHandle> {
      // Create child thread
      const childThreadId = generateUlid();

      await durableContext.step(`spawn-${agentName}-${childThreadId}`, async () => {
        // Create child thread with parent reference
        await createThread(childThreadId, agentName, {
          parentThreadId: threadId,
          spawnInput,
        });

        // Add child to parent's childThreadIds
        await addChildThread(threadId, childThreadId);

        // Persist agent_spawned message in parent thread
        const spawnMsgId = generateMessageId();
        const spawnValue = { type: "agent_spawned", agentId: childThreadId, agentName, input: spawnInput };
        await persistMessage(threadId, spawnMsgId, spawnValue);
        await broadcast(threadId, tymbal.set(spawnMsgId, spawnValue));
      });

      // Create handle with control methods
      const handle: AgentHandle = {
        id: childThreadId,
        parentId: threadId,
        input: spawnInput,

        async send(payload: unknown): Promise<SentMessage> {
          const msgId = generateMessageId();
          const msgValue = {
            type: "agent_message",
            id: msgId,
            senderId: threadId,
            payload,
            timestamp: new Date().toISOString(),
          };
          await persistMessage(childThreadId, msgId, msgValue);
          await broadcast(childThreadId, tymbal.set(msgId, msgValue));

          // Invoke child's callback if it's waiting
          const childMeta = await getThreadMeta(childThreadId);
          if (childMeta?.callbackId) {
            // TODO: Actually invoke the callback via Lambda Durable
          }

          return { id: msgId, threadId: childThreadId };
        },

        async cancel(): Promise<void> {
          // Send cancel event to child
          const msgId = generateMessageId();
          const cancelValue = { type: "cancel" };
          await persistMessage(childThreadId, msgId, cancelValue);
          await broadcast(childThreadId, tymbal.set(msgId, cancelValue));
        },

        async terminate(): Promise<void> {
          // Send terminate event to child
          const msgId = generateMessageId();
          const terminateValue = { type: "terminate" };
          await persistMessage(childThreadId, msgId, terminateValue);
          await broadcast(childThreadId, tymbal.set(msgId, terminateValue));
        },
      };

      // Start child execution asynchronously
      // TODO: Actually invoke the child's Lambda function
      // For now, the child will be started when it receives its first message
      // or the parent needs to trigger it via Lambda invocation

      return handle;
    },

    async sendTo(targetThreadId: string, payload: unknown): Promise<SentMessage> {
      const msgId = generateMessageId();
      const msgValue = {
        type: "agent_message",
        id: msgId,
        senderId: threadId,
        payload,
        timestamp: new Date().toISOString(),
      };
      await persistMessage(targetThreadId, msgId, msgValue);
      await broadcast(targetThreadId, tymbal.set(msgId, msgValue));

      // Invoke target's callback if it's waiting
      const targetMeta = await getThreadMeta(targetThreadId);
      if (targetMeta?.callbackId) {
        // TODO: Actually invoke the callback via Lambda Durable
      }

      return { id: msgId, threadId: targetThreadId };
    },

    async reply(message: AgentMessage, payload: unknown): Promise<SentMessage> {
      const msgId = generateMessageId();
      const msgValue = {
        type: "agent_message",
        id: msgId,
        senderId: threadId,
        payload,
        replyTo: message.id,
        timestamp: new Date().toISOString(),
      };
      await persistMessage(message.senderId, msgId, msgValue);
      await broadcast(message.senderId, tymbal.set(msgId, msgValue));

      // Invoke sender's callback if it's waiting
      const senderMeta = await getThreadMeta(message.senderId);
      if (senderMeta?.callbackId) {
        // TODO: Actually invoke the callback via Lambda Durable
      }

      return { id: msgId, threadId: message.senderId };
    },

    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return durableContext.step(`${stepPrefix}-custom-${name}`, fn);
    },

    parallel<T extends readonly unknown[]>(
      _name: string,
      _fns: { [K in keyof T]: () => Promise<T[K]> }
    ): Promise<T> {
      // TODO: Implement via Lambda Durable parallel
      throw new Error("parallel() not yet implemented");
    },

    map<T, R>(
      _name: string,
      _items: T[],
      _fn: (item: T, index: number) => Promise<R>,
      _opts?: { maxConcurrency?: number }
    ): Promise<R[]> {
      // TODO: Implement via Lambda Durable map
      throw new Error("map() not yet implemented");
    },

    config: process.config ?? {},
    threadId,
    input,
  };

  return ctx;
}

// =============================================================================
// Process Execution
// =============================================================================

interface ProcessEvent {
  threadId: string;
  agentName: string; // TODO: rename to processName in protocol
  input?: unknown;
}

async function runProcess(
  event: ProcessEvent,
  context: DurableContext,
  anthropic: Anthropic
): Promise<void> {
  const { threadId, agentName: processName, input } = event;
  const process = getProcess(processName);

  if (!process) {
    throw new Error(`Unknown process: ${processName}`);
  }

  const processKind = process.kind;
  console.log(`${processKind} "${processName}" started for thread ${threadId}`);

  // Store execution ARN in thread meta
  await context.step("store-execution-arn", async () => {
    await updateThreadMeta(threadId, {
      durableExecutionArn: context.executionContext?.executionArn ?? "unknown",
      status: "running",
    });
  });

  // Turn counter for unique step names
  let turn = 0;

  // Helper to load history
  const getHistory = async (): Promise<StoredMessage[]> => {
    return context.step(`load-history-${turn}`, async () => {
      const raw = await getThreadHistory(threadId);
      return raw as unknown as StoredMessage[];
    });
  };

  // Convert stored message to FlowEvent
  const messageToFlowEvent = (msg: StoredMessage): FlowEvent | null => {
    const { type } = msg.value;

    if (type === "user") {
      return { type: "message", content: String(msg.value.content ?? "") };
    }
    if (type === "agent_message") {
      return {
        type: "agent:message",
        id: String(msg.value.id ?? msg.msgId),
        senderId: String(msg.value.senderId ?? ""),
        payload: msg.value.payload,
        replyTo: msg.value.replyTo as string | undefined,
      };
    }
    if (type === "agent_complete") {
      return {
        type: "agent:complete",
        agentId: String(msg.value.agentId ?? ""),
        result: msg.value.result,
      };
    }
    if (type === "agent_terminated") {
      return {
        type: "agent:terminated",
        agentId: String(msg.value.agentId ?? ""),
        result: msg.value.result,
      };
    }
    if (type === "agent_error") {
      return {
        type: "agent:error",
        agentId: String(msg.value.agentId ?? ""),
        error: new Error(String(msg.value.error ?? "Unknown error")),
      };
    }
    if (type === "cancel") {
      return { type: "cancel" };
    }
    if (type === "terminate") {
      return { type: "terminate" };
    }

    return null;
  };

  // Helper to wait for next event
  const waitForEvent = async (): Promise<FlowEvent> => {
    // Wait for callback
    await context.waitForCallback<unknown>(
      `wait-event-${turn++}`,
      async (callbackId) => {
        await updateThreadMeta(threadId, { callbackId, status: "waiting" });
      },
      { timeout: { hours: 24 } }
    );

    // Load latest message to determine event type
    const history = await getHistory();
    const lastMsg = history[history.length - 1];

    if (lastMsg) {
      const event = messageToFlowEvent(lastMsg);
      if (event) return event;
    }

    // Default to message event
    return { type: "message", content: "" };
  };

  // Create context
  const ctx = createContext({
    threadId,
    process,
    anthropic,
    durableContext: context,
    stepPrefix: `turn-${turn}`,
    input,
    getHistory,
    waitForEvent,
  });

  // ==========================================================================
  // Route to appropriate execution mode based on kind
  // ==========================================================================

  try {
    if (process.kind === "workflow") {
      // Workflow mode: call onFlow once, returns result on completion
      console.log("Running workflow (onFlow mode)");

      // Track last processed message to detect new ones
      let lastProcessedMsgId: string | null = null;

      // Event types that trigger flow processing
      const eventTypes = ["user", "agent_message", "agent_complete", "agent_terminated", "agent_error", "cancel", "terminate"];

      // Helper to get pending event from history
      const getPendingEventForFlow = async (): Promise<FlowEvent | null> => {
        const history = await getHistory();
        // Find unprocessed events (user messages, agent messages, lifecycle events)
        for (let i = history.length - 1; i >= 0; i--) {
          const msg = history[i];
          if (eventTypes.includes(msg.value.type)) {
            if (lastProcessedMsgId === null || msg.msgId > lastProcessedMsgId) {
              lastProcessedMsgId = msg.msgId;
              return messageToFlowEvent(msg);
            }
            break;
          }
        }
        return null;
      };

      // Get or wait for first event
      let firstEvent = await getPendingEventForFlow();
      if (!firstEvent) {
        await context.waitForCallback<unknown>(
          `wait-first-event`,
          async (callbackId) => {
            await updateThreadMeta(threadId, { callbackId, status: "waiting" });
          },
          { timeout: { hours: 24 } }
        );
        firstEvent = await getPendingEventForFlow();
      }

      if (!firstEvent) {
        throw new Error("No event received for workflow");
      }

      // Create flow context with event stream
      let firstEventConsumed = false;
      const flowCtx = createContext({
        threadId,
        process,
        anthropic,
        durableContext: context,
        stepPrefix: `flow-${turn}`,
        input,
        getHistory,
        waitForEvent: async () => {
          if (!firstEventConsumed) {
            firstEventConsumed = true;
            return firstEvent!;
          }
          // Wait for next event
          let event = await getPendingEventForFlow();
          if (!event) {
            await context.waitForCallback<unknown>(
              `wait-flow-event-${turn++}`,
              async (callbackId) => {
                await updateThreadMeta(threadId, { callbackId, status: "waiting" });
              },
              { timeout: { hours: 24 } }
            );
            event = await getPendingEventForFlow();
          }
          return event ?? { type: "message", content: "" };
        },
      });

      // Execute workflow - will complete via return or ctx.complete()
      const result = await process.onFlow(flowCtx);
      console.log("Workflow completed with result:", result);

      // Persist thread_complete message with result
      const completeMsgId = generateMessageId();
      const completeValue = { type: "thread_complete", result };
      await persistMessage(threadId, completeMsgId, completeValue);
      await broadcast(threadId, tymbal.set(completeMsgId, completeValue));

      // Mark thread as completed
      await updateThreadMeta(threadId, { status: "completed" });

    } else if (process.kind === "agent" && process.onEvent) {
      // Agent with onEvent: call per event, loop forever (unless ctx.complete() called)
      console.log("Running agent (onEvent mode)");

      // Track last processed message to detect new ones
      let lastProcessedMsgId: string | null = null;

      // Event types that trigger event processing
      const eventTypes = ["user", "agent_message", "agent_complete", "agent_terminated", "agent_error", "cancel", "terminate"];

      // Helper to get pending event from history
      const getPendingEvent = async (): Promise<FlowEvent | null> => {
        const history = await getHistory();
        // Find unprocessed events (user messages, agent messages, lifecycle events)
        for (let i = history.length - 1; i >= 0; i--) {
          const msg = history[i];
          if (eventTypes.includes(msg.value.type)) {
            if (lastProcessedMsgId === null || msg.msgId > lastProcessedMsgId) {
              lastProcessedMsgId = msg.msgId;
              return messageToFlowEvent(msg);
            }
            break; // Already processed
          }
        }
        return null;
      };

      while (true) {
        // First check for pending events in history
        let event = await getPendingEvent();

        if (!event) {
          // No pending events, wait for new one
          await context.waitForCallback<unknown>(
            `wait-event-${turn}`,
            async (callbackId) => {
              await updateThreadMeta(threadId, { callbackId, status: "waiting" });
            },
            { timeout: { hours: 24 } }
          );
          event = await getPendingEvent();
        }

        if (!event) {
          console.log("No event found after callback, continuing...");
          turn++;
          continue;
        }

        console.log(`onEvent received: ${event.type}`);

        // Create fresh context for this event
        const eventCtx = createContext({
          threadId,
          process,
          anthropic,
          durableContext: context,
          stepPrefix: `event-${turn}`,
          input,
          getHistory,
          waitForEvent,
        });

        // Call handler
        await context.step(`handle-event-${turn}`, async () => {
          await process.onEvent!(event!, eventCtx);
        });

        turn++;
      }

    } else {
      // Default mode: automatic agentic loop (agent without onEvent)
      console.log("Running in default mode");
      await runDefaultAgentLoop(threadId, process, context, anthropic, getHistory, turn);
    }
  } catch (error) {
    // Handle completion signal
    if (error instanceof CompletionSignal) {
      console.log("Process completed with result:", error.result);
      return;
    }
    throw error;
  }
}

// =============================================================================
// Default Agent Loop (original behavior)
// =============================================================================

async function runDefaultAgentLoop(
  threadId: string,
  process: ProcessDefinition,
  context: DurableContext,
  anthropic: Anthropic,
  _getHistory: () => Promise<StoredMessage[]>,
  initialTurn: number
): Promise<void> {
  const model = process.config?.model ?? "claude-3-5-haiku-latest";
  let turn = initialTurn;

  // Initialize conversation state from DB once (stable step name for replay)
  // This is the key to durable memory - we load once and accumulate in memory
  const conversation: StoredMessage[] = await context.step(
    "init-conversation",
    async () => {
      console.log("Initializing conversation from DB");
      const raw = await getThreadHistory(threadId);
      return raw as unknown as StoredMessage[];
    }
  );

  console.log(`Conversation initialized with ${conversation.length} messages`);

  // Main agent loop
  while (true) {
    try {
      // Convert accumulated conversation to Claude format
      const claudeMessages = toClaudeMessages(conversation);

      // If no messages yet, wait for first user message
      if (claudeMessages.length === 0) {
        await context.waitForCallback<unknown>(
          `first-user-input-${turn}`,
          async (callbackId) => {
            await updateThreadMeta(threadId, { callbackId, status: "waiting" });
          },
          { timeout: { hours: 24 } }
        );

        // Load new message and add to conversation
        const newMessages = await context.step(
          `load-new-messages-${turn}`,
          async () => {
            const all = await getThreadHistory(threadId);
            return (all as unknown as StoredMessage[]).slice(conversation.length);
          }
        );
        conversation.push(...newMessages);
        console.log(`Added ${newMessages.length} new messages, total: ${conversation.length}`);

        turn++;
        continue;
      }

      // Check if we have listeners for streaming
      const shouldStream = await context.step(
        `check-listeners-${turn}`,
        async () => {
          return await hasListeners(threadId);
        }
      );

      // Generate message ID for assistant response
      const msgId = await context.step(`generate-msgid-${turn}`, async () => {
        return generateMessageId();
      });

      // Start frame if streaming
      if (shouldStream) {
        await context.step(`broadcast-start-${turn}`, async () => {
          await broadcast(threadId, tymbal.start(msgId, { type: "assistant" }));
        });
      }

      // Call Claude
      let fullText = "";
      const toolCalls: ToolCall[] = [];

      try {
        const result = await context.step(`call-claude-${turn}`, async () => {
          let text = "";
          const calls: ToolCall[] = [];

          const stream = anthropic.messages.stream({
            model,
            max_tokens: process.config?.maxTokens ?? 4096,
            system: process.system,
            messages: claudeMessages,
            tools: buildTools(process),
          });

          // Stream response
          for await (const streamEvent of stream) {
            if (streamEvent.type === "content_block_delta") {
              if (streamEvent.delta.type === "text_delta") {
                text += streamEvent.delta.text;
                if (shouldStream) {
                  await broadcast(
                    threadId,
                    tymbal.append(msgId, streamEvent.delta.text)
                  );
                }
              }
            }
          }

          // Get final message for tool calls
          const finalMessage = await stream.finalMessage();
          for (const block of finalMessage.content) {
            if (block.type === "tool_use") {
              calls.push({
                id: block.id,
                name: block.name,
                args: block.input as Record<string, unknown>,
              });
            }
          }

          return { text, calls };
        });

        fullText = result.text;
        toolCalls.push(...result.calls);
      } catch (error) {
        console.error("Claude API error:", error);

        // Persist error message
        const errorMsgId = generateMessageId();
        const errorValue = {
          type: "error",
          code: (error as { code?: string }).code ?? "claude_error",
          message: (error as Error).message ?? "Unknown error calling Claude",
        };
        await persistMessage(threadId, errorMsgId, errorValue);
        await broadcast(threadId, tymbal.set(errorMsgId, errorValue));

        // Wait for user to try again
        await context.waitForCallback<unknown>(
          `retry-after-error-${turn}`,
          async (callbackId) => {
            await updateThreadMeta(threadId, { callbackId, status: "waiting" });
          },
          { timeout: { hours: 24 } }
        );

        // Load any new messages after error recovery
        const newMessages = await context.step(
          `load-new-messages-after-error-${turn}`,
          async () => {
            const all = await getThreadHistory(threadId);
            return (all as unknown as StoredMessage[]).slice(conversation.length);
          }
        );
        conversation.push(...newMessages);

        turn++;
        continue;
      }

      console.log(
        `Claude response: ${fullText.length} chars, ${toolCalls.length} tool calls`
      );

      // Persist and broadcast assistant message only if it has text content
      if (fullText.length > 0) {
        const assistantValue = { type: "assistant", content: fullText };
        await context.step(`persist-assistant-${turn}`, async () => {
          await persistMessage(threadId, msgId, assistantValue);
          await broadcast(threadId, tymbal.set(msgId, assistantValue));
        });

        // Add to conversation memory
        conversation.push({ msgId, value: assistantValue } as StoredMessage);
      } else if (shouldStream) {
        // Clean up empty message - delete frame removes the orphaned start frame
        await context.step(`cleanup-empty-${turn}`, async () => {
          await broadcast(threadId, tymbal.delete(msgId));
        });
      }

      // Handle tool calls if any
      if (toolCalls.length > 0) {
        console.log(`Processing ${toolCalls.length} tool calls`);

        // Create minimal context for tool execution
        // Uses the conversation array which is already in-memory
        const toolCtx = createContext({
          threadId,
          process,
          anthropic,
          durableContext: context,
          stepPrefix: `tool-${turn}`,
          getHistory: async () => conversation,
          waitForEvent: async () => ({ type: "message", content: "" }),
        });

        for (const toolCall of toolCalls) {
          // Persist tool call
          const tcMsgId = await context.step(`tool-call-${turn}-${toolCall.id}`, async () => {
            const id = generateMessageId();
            const tcValue = {
              type: "tool_call",
              id: toolCall.id,
              name: toolCall.name,
              args: toolCall.args,
            };
            await persistMessage(threadId, id, tcValue);
            await broadcast(threadId, tymbal.set(id, tcValue));
            return id;
          });

          // Add tool call to conversation memory
          conversation.push({
            msgId: tcMsgId,
            value: { type: "tool_call", id: toolCall.id, name: toolCall.name, args: toolCall.args },
          } as StoredMessage);

          // Execute tool
          const tool = process.tools?.[toolCall.name];
          let result: unknown;

          if (!tool) {
            result = { error: `Unknown tool: ${toolCall.name}` };
          } else {
            result = await context.step(
              `execute-tool-${turn}-${toolCall.id}`,
              async () => {
                console.log(`Executing tool ${toolCall.name}`);
                return await tool.execute(toolCall.args, toolCtx);
              }
            );
          }

          // Persist tool result
          const resultMsgId = await context.step(`tool-result-${turn}-${toolCall.id}`, async () => {
            const id = generateMessageId();
            const resultValue = {
              type: "tool_result",
              callId: toolCall.id,
              content: result,
            };
            await persistMessage(threadId, id, resultValue);
            await broadcast(threadId, tymbal.set(id, resultValue));
            return id;
          });

          // Add tool result to conversation memory
          conversation.push({
            msgId: resultMsgId,
            value: { type: "tool_result", callId: toolCall.id, content: result },
          } as StoredMessage);
        }

        // Loop back to call Claude with tool results
        turn++;
        continue;
      }

      // No tool calls - turn complete, wait for user input
      await context.waitForCallback<unknown>(
        `user-input-${turn}`,
        async (callbackId) => {
          await updateThreadMeta(threadId, { callbackId, status: "waiting" });
        },
        { timeout: { hours: 24 } }
      );

      // Load new user message(s) and add to conversation
      const newMessages = await context.step(
        `load-new-messages-${turn}`,
        async () => {
          const all = await getThreadHistory(threadId);
          return (all as unknown as StoredMessage[]).slice(conversation.length);
        }
      );
      conversation.push(...newMessages);
      console.log(`Added ${newMessages.length} new messages, total: ${conversation.length}`);

      turn++;
    } catch (loopError) {
      console.error(`Turn ${turn} error:`, loopError);
      throw loopError;
    }
  }
}

// =============================================================================
// Handler Exports
// =============================================================================

/**
 * Create a simple (non-durable) process handler.
 */
export function createProcessHandler() {
  const anthropic = new Anthropic();

  return async (event: ProcessEvent): Promise<void> => {
    const simpleContext: DurableContext = {
      step: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      waitForCallback: async (): Promise<never> => {
        console.log("Non-durable mode: cannot wait for callback, exiting");
        throw new Error("waitForCallback not supported in non-durable mode");
      },
    };

    await runProcess(event, simpleContext, anthropic);
  };
}

/**
 * Create a durable process handler for Lambda Durable SDK.
 */
export function createDurableProcessHandler(): (
  event: ProcessEvent,
  context: DurableContext
) => Promise<void> {
  const anthropic = new Anthropic();

  return async (event: ProcessEvent, context: DurableContext): Promise<void> => {
    await runProcess(event, context, anthropic);
  };
}
