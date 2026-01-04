/**
 * Agent Runner for Test Harness
 *
 * Runs agent definitions against the test harness using MockLLMAdapter.
 * Provides a simplified execution environment for testing without full
 * durable execution overhead.
 */

import type { ProcessDefinition, Context, Message, ToolCall, ToolResult, GenerateResult, StepResult, FlowEvent, MessageHandle, SentMessage, AgentMessage } from "@cikada/agent";
import { MockLLMAdapter, mockTextResponse, type LLMAdapter, type StreamChunk, type ToolDefinition as LLMToolDefinition } from "@cikada/local-runtime";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ulid } from "ulid";
import type { MessageStore, ArtifactStore, Message as HarnessMessage } from "./stores.js";

// =============================================================================
// Types
// =============================================================================

export interface AgentRunnerOptions {
  /** LLM adapter (MockLLMAdapter or real) */
  llm?: LLMAdapter;
  /** Message store from harness */
  messageStore: MessageStore;
  /** Artifact store from harness */
  artifactStore: ArtifactStore;
  /** Channel name */
  channel: string;
  /** Agent name/id */
  agentName: string;
}

export interface RunAgentOptions {
  /** Agent definition to run */
  agent: ProcessDefinition;
  /** User message content */
  userMessage: string;
  /** Thread ID (for conversation tracking) */
  threadId?: string;
}

// =============================================================================
// Agent Runner
// =============================================================================

export class AgentRunner {
  private llm: LLMAdapter;
  private messageStore: MessageStore;
  private artifactStore: ArtifactStore;
  private channel: string;
  private agentName: string;

  constructor(options: AgentRunnerOptions) {
    this.llm = options.llm ?? new MockLLMAdapter();
    this.messageStore = options.messageStore;
    this.artifactStore = options.artifactStore;
    this.channel = options.channel;
    this.agentName = options.agentName;
  }

  /**
   * Queue a mock response for the next LLM call.
   * Only works with MockLLMAdapter.
   */
  queueResponse(text: string): this {
    if (this.llm instanceof MockLLMAdapter) {
      this.llm.queueResponse(mockTextResponse(text));
    }
    return this;
  }

  /**
   * Get the underlying LLM adapter.
   */
  getLLM(): LLMAdapter {
    return this.llm;
  }

  /**
   * Run an agent against a user message.
   */
  async run(options: RunAgentOptions): Promise<{ messages: HarnessMessage[] }> {
    const { agent, userMessage, threadId = ulid() } = options;
    const collectedMessages: HarnessMessage[] = [];

    // Create broadcast function that stores messages
    const broadcast = async (frame: string): Promise<void> => {
      // Parse Tymbal frame and extract message
      try {
        const parsed = JSON.parse(frame);
        if (parsed.v && typeof parsed.v === "object") {
          const msg = this.messageStore.add({
            channel: this.channel,
            sender: this.agentName,
            content: JSON.stringify(parsed.v),
            type: "message",
          });
          collectedMessages.push(msg);
        }
      } catch {
        // Not a JSON frame, ignore
      }
    };

    // Create context
    const ctx = this.createContext({
      threadId,
      agent,
      broadcast,
    });

    // Run the agent
    if (agent.kind === "workflow") {
      await agent.onFlow(ctx);
    } else if (agent.kind === "agent" && agent.onEvent) {
      await agent.onEvent({ type: "message", content: userMessage }, ctx);
    } else {
      // Default mode - run the agentic loop
      await ctx.llm.generate(userMessage);
    }

    return { messages: collectedMessages };
  }

  // ---------------------------------------------------------------------------
  // Context Factory
  // ---------------------------------------------------------------------------

  private createContext(options: {
    threadId: string;
    agent: ProcessDefinition;
    broadcast: (frame: string) => Promise<void>;
  }): Context {
    const { threadId, agent, broadcast } = options;
    const conversationHistory: Message[] = [];
    const pendingToolResults: Map<string, unknown> = new Map();
    let stepCounter = 0;

    // Tool conversion helper
    const buildTools = (): LLMToolDefinition[] | undefined => {
      if (!agent.tools || Object.keys(agent.tools).length === 0) {
        return undefined;
      }

      return Object.entries(agent.tools).map(([name, def]) => ({
        name,
        description: def.description,
        input_schema: zodToJsonSchema(def.parameters),
      }));
    };

    // Build messages for LLM
    const buildMessages = (userContent?: string): Message[] => {
      const messages: Message[] = [...conversationHistory];

      if (userContent) {
        messages.push({ role: "user", content: userContent });
      }

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
    };

    // Generate step
    const generateStep = async (content?: string): Promise<StepResult> => {
      const messages = buildMessages(content);
      const tools = buildTools();

      let fullText = "";
      const toolCalls: ToolCall[] = [];
      let stopReason: StepResult["stopReason"] = "end_turn";

      for await (const chunk of this.llm.stream({
        model: agent.config?.model ?? "mock",
        system: agent.system,
        messages,
        tools,
        max_tokens: agent.config?.maxTokens ?? 4096,
      })) {
        if (chunk.type === "text" && chunk.content) {
          fullText += chunk.content;
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

      // Broadcast assistant message
      if (fullText) {
        await broadcast(JSON.stringify({
          i: ulid(),
          v: { type: "assistant", content: fullText, sender: this.agentName },
        }));
      }

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

      return { text: fullText, toolCalls, stopReason };
    };

    // Generate (full agentic loop)
    const generate = async (content: string): Promise<GenerateResult> => {
      conversationHistory.push({ role: "user", content });

      let response = await generateStep();

      while (response.toolCalls.length > 0) {
        await Promise.all(response.toolCalls.map((call) => executeTool(call)));
        response = await generateStep();
      }

      return {
        text: response.text,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
    };

    // Execute tool
    const executeTool = async (call: ToolCall): Promise<ToolResult> => {
      const tool = agent.tools?.[call.name];

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
        const result = await tool.execute(call.args, ctx);
        pendingToolResults.set(call.id, result);

        // Broadcast tool result
        await broadcast(JSON.stringify({
          i: ulid(),
          v: { type: "tool_result", toolName: call.name, callId: call.id, content: result },
        }));

        return { callId: call.id, result, isError: false };
      } catch (err) {
        const errorResult = { error: String(err) };
        pendingToolResults.set(call.id, errorResult);
        return { callId: call.id, result: errorResult, isError: true };
      }
    };

    // Tool result
    const toolResult = async (callId: string, result: unknown): Promise<void> => {
      pendingToolResults.set(callId, result);
    };

    // Message handle
    const message = (value: Record<string, unknown>): MessageHandle => {
      const msgId = ulid();
      return {
        id: msgId,
        stream: async (text: string) => {
          await broadcast(JSON.stringify({ i: msgId, a: text }));
        },
        set: async (v: Record<string, unknown>) => {
          await broadcast(JSON.stringify({ i: msgId, v }));
        },
        delete: async () => {
          await broadcast(JSON.stringify({ i: msgId, v: null }));
        },
      };
    };

    // Events (not supported in test harness)
    const events: Context["events"] = {
      async next(): Promise<FlowEvent> {
        throw new Error("events.next() not supported in test harness");
      },
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("events iteration not supported in test harness");
          },
        };
      },
    };

    // Completion
    const complete = async (result?: unknown): Promise<void> => {
      await broadcast(JSON.stringify({
        i: ulid(),
        v: { type: "thread_complete", result },
      }));
    };

    // Stub implementations
    const spawn = async (): Promise<never> => {
      throw new Error("spawn() not supported in test harness");
    };

    const onTerminate = (_handler: () => Promise<unknown>): void => {
      // No-op
    };

    const sendTo = async (_threadId: string, _payload: unknown): Promise<SentMessage> => {
      throw new Error("sendTo() not supported in test harness");
    };

    const reply = async (_message: AgentMessage, _payload: unknown): Promise<SentMessage> => {
      throw new Error("reply() not supported in test harness");
    };

    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      return fn(); // No durability in test harness
    };

    const parallel = async <T extends readonly unknown[]>(
      _name: string,
      fns: { [K in keyof T]: () => Promise<T[K]> }
    ): Promise<T> => {
      const results = await Promise.all(fns.map((fn) => fn()));
      return results as unknown as T;
    };

    const map = async <T, R>(
      _name: string,
      items: T[],
      fn: (item: T, index: number) => Promise<R>,
      _opts?: { maxConcurrency?: number }
    ): Promise<R[]> => {
      return Promise.all(items.map((item, index) => fn(item, index)));
    };

    // Build context
    const ctx: Context = {
      events,
      llm: { generate, generateStep },
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
      config: agent.config ?? {},
      threadId,
    };

    return ctx;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  return new AgentRunner(options);
}
