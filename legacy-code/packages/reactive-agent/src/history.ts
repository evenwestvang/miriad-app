/**
 * History Conversion Utilities
 *
 * Converts StoredMessage arrays to LLM message format.
 * Handles the various message types in the channel-based model.
 */

import type { StoredMessage } from "@cikada/core";
import type { LLMMessage, LLMContentBlock } from "./adapters/llm.js";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a message represents text content (for backwards compatibility).
 * Some systems may use 'agent_message' or similar types with text content.
 */
function isTextMessage(msg: StoredMessage): boolean {
  // Check if content looks like text content
  const content = msg.content as { text?: string } | string | unknown;
  if (typeof content === "string") return true;
  if (content && typeof content === "object" && "text" in content) return true;
  return false;
}

// =============================================================================
// History Conversion
// =============================================================================

/**
 * Convert StoredMessage array to LLM message format.
 * Handles text messages, tool calls, and tool results.
 */
export function convertHistoryToMessages(history: StoredMessage[]): LLMMessage[] {
  const messages: LLMMessage[] = [];

  for (const msg of history) {
    // Handle different message types based on StoredMessageType
    // Note: The canonical format uses 'user' and 'assistant' directly, not 'text' + senderType
    if (msg.type === "user" || (msg.senderType === "user" && isTextMessage(msg))) {
      // Human text message
      const content = msg.content as { text?: string } | string;
      const text = typeof content === "string" ? content : content?.text || "";
      if (text) {
        messages.push({
          role: "user",
          content: text,
        });
      }
    } else if (
      msg.type === "assistant" ||
      (msg.senderType === "agent" && isTextMessage(msg))
    ) {
      // Agent text message
      const content = msg.content as { text?: string; content?: string } | string;
      const text =
        typeof content === "string"
          ? content
          : content?.text || content?.content || "";
      if (text) {
        messages.push({
          role: "assistant",
          content: text,
        });
      }
    } else if (msg.type === "tool_call") {
      // Tool call from assistant - append to last assistant message or create new
      const toolContent = msg.content as {
        id: string;
        name: string;
        args: Record<string, unknown>;
      };

      const lastMsg = messages[messages.length - 1];
      const toolUseBlock: LLMContentBlock = {
        type: "tool_use",
        id: toolContent.id,
        name: toolContent.name,
        input: toolContent.args,
      };

      if (lastMsg && lastMsg.role === "assistant") {
        // Append tool use to existing assistant message
        if (typeof lastMsg.content === "string") {
          const textContent = lastMsg.content;
          lastMsg.content = textContent
            ? [{ type: "text", text: textContent }, toolUseBlock]
            : [toolUseBlock];
        } else if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(toolUseBlock);
        }
      } else {
        messages.push({
          role: "assistant",
          content: [toolUseBlock],
        });
      }
    } else if (msg.type === "tool_result") {
      // Tool result - add as user message with tool_result block
      const resultContent = msg.content as {
        call_id?: string;
        tool_use_id?: string;
        content: string;
      };

      const toolUseId = resultContent.call_id || resultContent.tool_use_id || "";
      const resultText =
        typeof resultContent.content === "string"
          ? resultContent.content
          : JSON.stringify(resultContent.content);

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: resultText,
          },
        ],
      });
    }
  }

  return messages;
}

/**
 * Merge user content with pending tool results.
 * Used when the LLM needs both a user message and tool results.
 */
export function mergeToolResultsWithUser(
  userContent: string | undefined,
  pendingToolResults: Map<string, unknown>
): LLMMessage | null {
  const contentBlocks: LLMContentBlock[] = [];

  // Add tool results
  for (const [callId, result] of pendingToolResults.entries()) {
    contentBlocks.push({
      type: "tool_result",
      tool_use_id: callId,
      content: typeof result === "string" ? result : JSON.stringify(result),
    });
  }

  // Add user content if present
  if (userContent) {
    contentBlocks.push({
      type: "text",
      text: userContent,
    });
  }

  if (contentBlocks.length === 0) {
    return null;
  }

  return {
    role: "user",
    content: contentBlocks,
  };
}

// =============================================================================
// Tymbal-Native JIT Conversion
// =============================================================================

/**
 * Stored message shape for Tymbal-native format.
 * Uses a minimal interface to avoid circular dependencies with @cikada/core.
 */
export interface TymbalStoredMessage {
  id: string;
  type: string;
  content: unknown;
  sender: string;
  senderType: string;
  timestamp: string;
  turnId?: string;
}

/**
 * Content shape for tool_call messages.
 */
interface ToolCallContent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Content shape for tool_result messages.
 */
interface ToolResultContent {
  call_id: string;
  name?: string;
  content: string;
  isError?: boolean;
}

/**
 * Content shape for assistant messages (Tymbal format).
 */
interface AssistantContent {
  content?: string;
  text?: string;
  type?: string;
}

/**
 * Convert Tymbal-format stored messages to Anthropic LLM message format.
 *
 * This is the JIT (just-in-time) conversion function for Tymbal-native persistence.
 * Messages are stored in Tymbal format and converted to Anthropic format only
 * when constructing LLM API calls.
 *
 * Key insight: Within a single turnId, there can be multiple assistant messages
 * (e.g., one before tool calls, one after tool results). Tool_calls must only be
 * attached to the assistant message that PRECEDES them in the sequence.
 *
 * The conversion handles:
 * - Assistant + immediately following tool_calls -> single assistant with tool_use blocks
 * - Tool results -> user messages with tool_result content blocks
 * - Multiple assistant messages per turn are handled correctly
 *
 * @param messages - Stored messages in Tymbal format (ordered by timestamp/id)
 * @returns Messages in Anthropic API format ready for LLM calls
 */
export function convertTymbalHistoryToAnthropic(
  messages: TymbalStoredMessage[]
): LLMMessage[] {
  const result: LLMMessage[] = [];

  // Track which messages we've processed (to avoid duplicates)
  const processedIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip if already processed
    if (processedIds.has(msg.id)) {
      continue;
    }

    // User messages -> user role
    if (msg.type === "user") {
      const content = extractTymbalTextContent(msg.content);
      result.push({ role: "user", content });
      processedIds.add(msg.id);
      continue;
    }

    // Assistant messages -> check for IMMEDIATELY FOLLOWING tool_calls
    if (msg.type === "assistant") {
      const assistantContent = buildAssistantContentSequential(
        msg,
        messages,
        i,
        processedIds
      );
      result.push({ role: "assistant", content: assistantContent });
      processedIds.add(msg.id);
      continue;
    }

    // Tool call messages - should be processed with preceding assistant message
    // If we hit one here, it means there was no preceding assistant message
    if (msg.type === "tool_call") {
      // Create a standalone assistant message with just tool_use
      const toolContent = extractToolCallContent(msg.content);
      const toolUseBlock: LLMContentBlock = {
        type: "tool_use",
        id: toolContent.id,
        name: toolContent.name,
        input: toolContent.args ?? {},
      };
      result.push({ role: "assistant", content: [toolUseBlock] });
      processedIds.add(msg.id);
      continue;
    }

    // Tool result messages -> user role with tool_result blocks
    if (msg.type === "tool_result") {
      const toolContent = extractToolResultContent(msg.content);
      const content: LLMContentBlock[] = [
        {
          type: "tool_result",
          tool_use_id: toolContent.call_id ?? "unknown",
          content: toolContent.content ?? JSON.stringify(msg.content),
        },
      ];
      result.push({ role: "user", content });
      processedIds.add(msg.id);
      continue;
    }

    // Unknown message type - skip
  }

  return result;
}

/**
 * Build assistant message content by looking at IMMEDIATELY FOLLOWING tool_calls.
 * Only attaches tool_calls that come right after this assistant message,
 * before any tool_result or another assistant message.
 */
function buildAssistantContentSequential(
  assistantMsg: TymbalStoredMessage,
  allMessages: TymbalStoredMessage[],
  currentIndex: number,
  processedIds: Set<string>
): string | LLMContentBlock[] {
  const textContent = extractTymbalTextContent(assistantMsg.content);

  // Collect tool_calls that immediately follow this assistant message
  const toolCalls: TymbalStoredMessage[] = [];

  for (let j = currentIndex + 1; j < allMessages.length; j++) {
    const nextMsg = allMessages[j];

    // Stop if we hit a tool_result, another assistant message, or user message
    if (
      nextMsg.type === "tool_result" ||
      nextMsg.type === "assistant" ||
      nextMsg.type === "user"
    ) {
      break;
    }

    // Collect tool_call messages
    if (nextMsg.type === "tool_call" && !processedIds.has(nextMsg.id)) {
      toolCalls.push(nextMsg);
    }
  }

  // If no tool calls found, return simple text
  if (toolCalls.length === 0) {
    return textContent;
  }

  // Build content blocks array with text + tool_use blocks
  const contentBlocks: LLMContentBlock[] = [];

  // Add text block if there's text content
  if (textContent) {
    contentBlocks.push({ type: "text", text: textContent });
  }

  // Add tool_use blocks for each tool call
  for (const tc of toolCalls) {
    const toolContent = extractToolCallContent(tc.content);
    contentBlocks.push({
      type: "tool_use",
      id: toolContent.id,
      name: toolContent.name,
      input: toolContent.args ?? {},
    });
    // Mark tool_call as processed
    processedIds.add(tc.id);
  }

  return contentBlocks;
}

/**
 * Extract tool_call content, handling nested Tymbal format.
 * Content may be { id, name, args } or { type, id, name, args, sender, ... }
 */
function extractToolCallContent(content: unknown): ToolCallContent {
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    return {
      id: (obj.id as string) ?? "unknown",
      name: (obj.name as string) ?? "unknown",
      args: (obj.args as Record<string, unknown>) ?? {},
    };
  }
  return { id: "unknown", name: "unknown", args: {} };
}

/**
 * Extract tool_result content, handling nested Tymbal format.
 * Content may be { call_id, content } or { type, call_id, content, sender, ... }
 */
function extractToolResultContent(content: unknown): ToolResultContent {
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    return {
      call_id: (obj.call_id as string) ?? "unknown",
      name: obj.name as string | undefined,
      content: (obj.content as string) ?? JSON.stringify(content),
      isError: obj.isError as boolean | undefined,
    };
  }
  return { call_id: "unknown", content: JSON.stringify(content) };
}

/**
 * Extract text content from various Tymbal message content formats.
 */
function extractTymbalTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (content && typeof content === "object") {
    const obj = content as AssistantContent;
    // Handle { content: "..." } format
    if (typeof obj.content === "string") {
      return obj.content;
    }
    // Handle { text: "..." } format
    if (typeof obj.text === "string") {
      return obj.text;
    }
  }

  // Fallback: stringify the content
  return JSON.stringify(content ?? "");
}
