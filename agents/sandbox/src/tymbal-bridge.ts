/**
 * Tymbal Bridge (SDK Version)
 *
 * Translates Claude Agent SDK messages to Tymbal protocol frames
 * and streams them to the Cast server via HTTP POST.
 *
 * SDK Message Types:
 * - SDKSystemMessage: Init with session_id, model, tools (not emitted)
 * - SDKAssistantMessage: Full assistant response with content blocks
 * - SDKPartialAssistantMessage: Streaming deltas (logged, not emitted in Phase 2)
 * - SDKUserMessage: User/tool result messages (tool_result blocks emitted)
 * - SDKResultMessage: Conversation turn complete
 *
 * Phase 2 Frame Flow (no streaming):
 * - Start frame on first partial message
 * - Set frame on full assistant message
 * - No append frames (deferred to Phase 3 due to HTTP ordering concerns)
 */

import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Content block types from Anthropic API
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

// ULID generation (Crockford's Base32, 26 characters)
// Format: 10 chars timestamp + 16 chars randomness
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's Base32

function generateId(): string {
  const now = Date.now();

  // Encode timestamp (48 bits -> 10 chars)
  let timestamp = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timestamp = ENCODING[t % 32] + timestamp;
    t = Math.floor(t / 32);
  }

  // Generate randomness (80 bits -> 16 chars)
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ENCODING[Math.floor(Math.random() * 32)];
  }

  return timestamp + random;
}

export interface TymbalBridgeConfig {
  serverUrl: string;
  channelId: string;
  /** Agent callsign for sender attribution in frames */
  callsign?: string;
  /** Container auth token for Tymbal POSTs */
  authToken?: string;
}

export interface TymbalFrame {
  i: string; // Message ID
  t?: string; // Timestamp (for set frames)
  m?: Record<string, unknown>; // Metadata (for start frames)
  a?: string; // Append content (Phase 3)
  v?: unknown; // Set value (or null for delete)
}

export class TymbalBridge {
  private readonly serverUrl: string;
  private readonly channelId: string;
  private readonly callsign: string;
  private readonly authToken: string | null;

  // Session state
  private sessionId: string | null = null;

  // Current message tracking
  private currentAssistantMsgId: string | null = null;
  private assistantContent: string = "";
  private startFrameEmitted: boolean = false;

  constructor(config: TymbalBridgeConfig) {
    this.serverUrl = config.serverUrl;
    this.channelId = config.channelId;
    this.callsign = config.callsign ?? "claude-code";
    this.authToken = config.authToken ?? null;
  }

  /**
   * Get the session ID (available after processing SDKSystemMessage).
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Process an SDK message and emit appropriate Tymbal frames.
   */
  async processSDKMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case "system":
        await this.handleSystem(message as SDKSystemMessage);
        break;

      case "assistant":
        await this.handleAssistant(message as SDKAssistantMessage);
        break;

      case "stream_event":
        await this.handlePartialAssistant(message as SDKPartialAssistantMessage);
        break;

      case "user":
        await this.handleUser(message as SDKUserMessage);
        break;

      case "result":
        await this.handleResult(message as SDKResultMessage);
        break;

      case "tool_progress":
        // Phase 3: Tool progress events
        console.log(`[TymbalBridge] Tool progress: ${JSON.stringify(message)}`);
        break;

      default:
        console.log(`[TymbalBridge] Unhandled message type: ${(message as SDKMessage).type}`);
    }
  }

  /**
   * Handle system init message - store session_id.
   */
  private async handleSystem(message: SDKSystemMessage): Promise<void> {
    if (message.subtype === "init") {
      this.sessionId = message.session_id;
      console.log(`[TymbalBridge] Session initialized: ${this.sessionId}`);
      console.log(`[TymbalBridge] Model: ${message.model}`);
      console.log(`[TymbalBridge] Tools: ${message.tools.join(", ")}`);
    }
  }

  /**
   * Handle partial assistant message (streaming).
   * Phase 2: Log only, don't emit append frames.
   */
  private async handlePartialAssistant(message: SDKPartialAssistantMessage): Promise<void> {
    const event = message.event;

    // Handle content_block_start - emit start frame
    if (event.type === "content_block_start") {
      if (!this.currentAssistantMsgId) {
        this.currentAssistantMsgId = generateId();
        this.assistantContent = "";
        this.startFrameEmitted = false;
      }

      // Emit start frame on first content block
      if (!this.startFrameEmitted) {
        await this.emitFrame({
          i: this.currentAssistantMsgId,
          m: { type: "agent", sender: this.callsign, senderType: "agent" },
        });
        this.startFrameEmitted = true;
      }
    }

    // Handle content_block_delta - accumulate content (no append in Phase 2)
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta && "type" in delta && delta.type === "text_delta" && "text" in delta) {
        this.assistantContent += (delta as { text: string }).text;
        // Phase 2: Log but don't emit append frames
        // console.log(`[TymbalBridge] Delta: ${(delta as { text: string }).text}`);
      }
    }
  }

  /**
   * Handle full assistant message - extract text and tool_use blocks.
   */
  private async handleAssistant(message: SDKAssistantMessage): Promise<void> {
    const content = message.message.content as ContentBlock[];
    if (!content) return;

    // Extract text content
    let textContent = "";
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of content) {
      if (block.type === "text" && "text" in block) {
        textContent += (block as TextBlock).text;
      } else if (block.type === "tool_use" && "id" in block && "name" in block) {
        toolUseBlocks.push(block as ToolUseBlock);
      }
    }

    // Emit set frame for text content
    if (textContent) {
      const msgId = this.currentAssistantMsgId ?? generateId();

      // Emit start frame if not already done
      if (!this.startFrameEmitted) {
        await this.emitFrame({
          i: msgId,
          m: { type: "agent", sender: this.callsign, senderType: "agent" },
        });
      }

      // Emit set frame with full content
      await this.emitFrame({
        i: msgId,
        t: new Date().toISOString(),
        v: {
          type: "agent",
          sender: this.callsign,
          senderType: "agent",
          content: textContent,
        },
      });

      // Reset state
      this.currentAssistantMsgId = null;
      this.assistantContent = "";
      this.startFrameEmitted = false;
    }

    // Emit tool_call frames for each tool use
    for (const toolBlock of toolUseBlocks) {
      const toolCallId = generateId();
      await this.emitFrame({
        i: toolCallId,
        t: new Date().toISOString(),
        v: {
          type: "tool_call",
          sender: this.callsign,
          senderType: "agent",
          toolCallId: toolBlock.id,
          name: toolBlock.name,
          args: toolBlock.input,
        },
      });
    }
  }

  /**
   * Handle user message - extract tool_result blocks.
   */
  private async handleUser(message: SDKUserMessage): Promise<void> {
    const apiMessage = message.message;
    const content = apiMessage.content;

    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block === "object" && block !== null && "type" in block) {
        const typedBlock = block as ContentBlock;
        if (typedBlock.type === "tool_result" && "tool_use_id" in typedBlock) {
          const resultBlock = typedBlock as ToolResultBlock;
          const resultId = generateId();

          // Determine result status and content
          const isError = resultBlock.is_error ?? false;
          let resultContent: unknown = resultBlock.content;

          // Extract text content if it's an array
          if (Array.isArray(resultContent)) {
            resultContent = resultContent
              .filter(
                (item): item is { type: "text"; text: string } =>
                  typeof item === "object" && item !== null && item.type === "text"
              )
              .map((item) => item.text)
              .join("\n");
          }

          await this.emitFrame({
            i: resultId,
            t: new Date().toISOString(),
            v: {
              type: "tool_result",
              sender: this.callsign,
              senderType: "agent",
              toolCallId: resultBlock.tool_use_id,
              content: resultContent,
              isError,
            },
          });
        }
      }
    }
  }

  /**
   * Handle result message - emit idle frame.
   */
  private async handleResult(message: SDKResultMessage): Promise<void> {
    // Finalize any pending assistant message
    if (this.currentAssistantMsgId && this.assistantContent) {
      await this.emitFrame({
        i: this.currentAssistantMsgId,
        t: new Date().toISOString(),
        v: {
          type: "agent",
          sender: this.callsign,
          senderType: "agent",
          content: this.assistantContent,
        },
      });
      this.currentAssistantMsgId = null;
      this.assistantContent = "";
      this.startFrameEmitted = false;
    }

    // Check for errors
    if (message.subtype !== "success") {
      const errorMsg = message as { errors?: string[] };
      const errorMessage = errorMsg.errors?.join(", ") ?? `Error: ${message.subtype}`;

      const errorId = generateId();
      await this.emitFrame({
        i: errorId,
        t: new Date().toISOString(),
        v: {
          type: "error",
          sender: this.callsign,
          senderType: "agent",
          message: errorMessage,
        },
      });
    }

    // Emit idle frame
    const idleId = generateId();
    await this.emitFrame({
      i: idleId,
      t: new Date().toISOString(),
      v: {
        type: "idle",
        sender: this.callsign,
      },
    });

    // Log usage stats
    if (message.subtype === "success") {
      console.log(`[TymbalBridge] Turn complete: ${message.num_turns} turns, $${message.total_cost_usd.toFixed(4)}`);
    }
  }

  /**
   * Finalize any pending messages (call at end of conversation).
   */
  async finalize(): Promise<void> {
    if (this.currentAssistantMsgId && this.assistantContent) {
      await this.emitFrame({
        i: this.currentAssistantMsgId,
        t: new Date().toISOString(),
        v: {
          type: "agent",
          sender: this.callsign,
          senderType: "agent",
          content: this.assistantContent,
        },
      });
      this.currentAssistantMsgId = null;
      this.assistantContent = "";
      this.startFrameEmitted = false;
    }
  }

  /**
   * Emit a Tymbal frame to the server via HTTP POST.
   */
  private async emitFrame(frame: TymbalFrame): Promise<void> {
    const frameJson = JSON.stringify(frame);
    console.log(`[Tymbal] ${frameJson}`);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add container auth if available
      if (this.authToken) {
        headers["Authorization"] = `Container ${this.authToken}`;
      }

      const response = await fetch(`${this.serverUrl}/tymbal/${this.channelId}`, {
        method: "POST",
        headers,
        body: frameJson,
      });

      if (!response.ok) {
        console.error(`[Tymbal] Failed to emit frame: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`[Tymbal] Error emitting frame:`, error);
    }
  }
}
