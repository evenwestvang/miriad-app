/**
 * SDK Agent Handler - Claude Agent SDK Integration
 *
 * This handler wraps the Claude Agent SDK to provide a sandbox agent
 * with full code execution capabilities. The SDK's event stream becomes
 * our thread interface.
 *
 * Key concepts:
 * - Input stream: User messages from WebSocket -> Pushable<SDKUserMessage>
 * - Output stream: SDK events -> Tymbal protocol frames
 * - Session persistence: workdir/.claude folder + continue: true
 */

import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKToolProgressMessage,
  type SDKSystemMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getThreadHistory,
  getThreadMeta,
  persistMessage,
  updateThreadMeta,
} from "../../shared/db.js";
import { broadcast, hasListeners } from "../../shared/broadcast.js";
import { tymbal } from "@cikada/core/tymbal";
import { generateMessageId } from "../../shared/ulid.js";
import * as fs from "fs/promises";
import * as path from "path";

// =============================================================================
// Types
// =============================================================================

export interface SDKAgentEvent {
  threadId: string;
  workdirBase: string; // Base path for workdirs (e.g., /mnt/efs or /tmp)
  systemPrompt?: string;
  mcpServers?: Record<string, { type: string; url?: string }>;
}

interface StoredMessageValue {
  type: string;
  content?: unknown;
}

interface StoredMessage {
  msgId: string;
  value: StoredMessageValue;
}

// =============================================================================
// Pushable Stream Implementation
// =============================================================================

/**
 * Pushable async iterable for injecting messages into the SDK input stream.
 * Based on PowPow's pattern for mid-turn message injection.
 */
class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    this.ended = true;
    // Resolve all waiters with done
    for (const waiter of this.waiters) {
      waiter({ value: undefined as T, done: true });
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return { value: this.queue.shift()!, done: false };
        }

        if (this.ended) {
          return { value: undefined as T, done: true };
        }

        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

// =============================================================================
// SDK Message -> Tymbal Protocol Mapping
// =============================================================================

/**
 * Map SDK message types to Tymbal protocol frames.
 * This keeps the frontend unchanged - we translate to our existing protocol.
 */
async function handleSDKMessage(
  threadId: string,
  message: SDKMessage,
  currentMsgId: { value: string | null }
): Promise<void> {
  const shouldStream = await hasListeners(threadId);

  switch (message.type) {
    case "system": {
      // System messages include init, status updates
      // Log but don't emit to UI (or emit as system message if needed)
      console.log(`[SDK] System: ${JSON.stringify(message)}`);
      break;
    }

    case "assistant": {
      // Complete assistant message with text and/or tool_use blocks
      const assistantMsg = message as SDKAssistantMessage;
      const content = assistantMsg.message?.content;
      if (!content || !Array.isArray(content)) break;

      let textContent = "";
      for (const block of content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          // Tool call - emit as separate message
          const tcMsgId = generateMessageId();
          const tcValue = {
            type: "tool_call",
            id: block.id,
            name: block.name,
            args: block.input,
          };
          await persistMessage(threadId, tcMsgId, tcValue);
          await broadcast(threadId, tymbal.set(tcMsgId, tcValue));
        }
      }

      // Persist complete assistant text if any
      if (textContent) {
        if (!currentMsgId.value) {
          currentMsgId.value = generateMessageId();
        }
        await persistMessage(threadId, currentMsgId.value, {
          type: "assistant",
          content: textContent,
        });
        await broadcast(threadId, tymbal.set(currentMsgId.value, {
          type: "assistant",
          content: textContent,
        }));
      }
      break;
    }

    case "stream_event": {
      // Partial assistant message for streaming
      // The event field contains RawMessageStreamEvent from Anthropic SDK
      const streamEvent = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (!streamEvent) break;

      if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
        // Generate ID upfront to ensure it's never null for append
        // This prevents race conditions where async broadcast could interleave
        const msgId = currentMsgId.value ?? generateMessageId();
        const needsStart = !currentMsgId.value;
        currentMsgId.value = msgId;

        // Start message if needed
        if (needsStart && shouldStream) {
          await broadcast(threadId, tymbal.start(msgId, { type: "assistant" }));
        }

        // Stream text delta
        if (shouldStream && streamEvent.delta.text) {
          await broadcast(threadId, tymbal.append(msgId, streamEvent.delta.text));
        }
      }
      break;
    }

    case "tool_progress": {
      // Tool execution progress - emit for UI feedback
      // Full detail for firehose-style tool activity
      const progressMsg = message as SDKToolProgressMessage;
      const progressMsgId = generateMessageId();
      const progressValue = {
        type: "tool_progress",
        toolUseId: progressMsg.tool_use_id,
        toolName: progressMsg.tool_name,
        elapsedSeconds: progressMsg.elapsed_time_seconds,
        parentToolUseId: progressMsg.parent_tool_use_id,
      };
      // Don't persist progress messages, just broadcast
      if (shouldStream) {
        await broadcast(threadId, tymbal.set(progressMsgId, progressValue));
      }
      break;
    }

    case "result": {
      // Completion result - success or error
      const resultMsg = message as SDKResultMessage;
      const resultMsgId = generateMessageId();
      const isSuccess = resultMsg.subtype === "success";
      const resultValue = {
        type: isSuccess ? "sdk_complete" : "sdk_error",
        subtype: resultMsg.subtype,
        durationMs: resultMsg.duration_ms,
        numTurns: resultMsg.num_turns,
        totalCostUsd: isSuccess ? (resultMsg as Extract<SDKResultMessage, { subtype: "success" }>).total_cost_usd : undefined,
        result: isSuccess ? (resultMsg as Extract<SDKResultMessage, { subtype: "success" }>).result : undefined,
      };
      await persistMessage(threadId, resultMsgId, resultValue);
      await broadcast(threadId, tymbal.set(resultMsgId, resultValue));
      break;
    }

    default: {
      // Unknown message type - log it
      console.log(`[SDK] Unknown message type: ${JSON.stringify(message)}`);
    }
  }
}

// =============================================================================
// Workdir Management
// =============================================================================

/**
 * Get or create workdir for a thread.
 * Each thread gets its own isolated workspace.
 */
async function ensureWorkdir(base: string, threadId: string): Promise<string> {
  const workdir = path.join(base, "workdirs", threadId);
  await fs.mkdir(workdir, { recursive: true });
  return workdir;
}

/**
 * Check if a session already exists (has .claude folder).
 */
async function hasExistingSession(workdir: string): Promise<boolean> {
  try {
    await fs.access(path.join(workdir, ".claude"));
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Run the SDK agent for a thread.
 * This is the core integration - it maps our thread interface to SDK streams.
 */
export async function runSDKAgent(event: SDKAgentEvent): Promise<void> {
  const { threadId, workdirBase, systemPrompt, mcpServers } = event;

  console.log(`[SDK Agent] Starting for thread ${threadId}`);

  // Ensure workdir exists
  const workdir = await ensureWorkdir(workdirBase, threadId);
  const hasSession = await hasExistingSession(workdir);
  console.log(`[SDK Agent] Workdir: ${workdir}, existing session: ${hasSession}`);

  // Update thread status
  await updateThreadMeta(threadId, { status: "running" });

  // Create input stream for user messages
  const input = new Pushable<SDKUserMessage>();

  // Load existing history and inject as initial messages
  const history = await getThreadHistory(threadId) as unknown as StoredMessage[];
  for (const msg of history) {
    if (msg.value.type === "user") {
      input.push({
        type: "user",
        message: {
          role: "user",
          content: String(msg.value.content ?? ""),
        },
        parent_tool_use_id: null,
        session_id: threadId,
      });
    }
  }

  // SDK options
  const options: Options = {
    model: "claude-sonnet-4-20250514",
    cwd: workdir,
    systemPrompt: systemPrompt
      ? {
          type: "preset",
          preset: "claude_code",
          append: systemPrompt,
        }
      : {
          type: "preset",
          preset: "claude_code",
        },
    mcpServers: mcpServers as Options["mcpServers"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    continue: hasSession,
  };

  // Start the SDK query
  const q = query({ prompt: input, options });

  // Track current assistant message for streaming
  const currentMsgId = { value: null as string | null };

  // Process output stream
  try {
    for await (const message of q) {
      await handleSDKMessage(threadId, message, currentMsgId);

      // Reset message ID after each complete assistant turn
      if (message.type === "result") {
        currentMsgId.value = null;
      }
    }
  } catch (error) {
    console.error(`[SDK Agent] Error:`, error);

    // Emit error to thread
    const errorMsgId = generateMessageId();
    const errorValue = {
      type: "error",
      code: "sdk_error",
      message: (error as Error).message ?? "Unknown SDK error",
    };
    await persistMessage(threadId, errorMsgId, errorValue);
    await broadcast(threadId, tymbal.set(errorMsgId, errorValue));
  } finally {
    // Update thread status
    await updateThreadMeta(threadId, { status: "waiting" });
  }
}

/**
 * Handle incoming user message for SDK agent.
 * Called when a new message arrives on the thread.
 */
export async function handleUserMessage(
  threadId: string,
  content: string,
  inputStream: Pushable<SDKUserMessage>
): Promise<void> {
  // Persist user message
  const msgId = generateMessageId();
  await persistMessage(threadId, msgId, { type: "user", content });
  await broadcast(threadId, tymbal.set(msgId, { type: "user", content }));

  // Inject into SDK input stream
  inputStream.push({
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    session_id: threadId,
  });
}

/**
 * Create handler for SDK agent Lambda.
 */
export function createSDKAgentHandler() {
  return async (event: SDKAgentEvent): Promise<void> => {
    await runSDKAgent(event);
  };
}
