/**
 * Tymbal Bridge
 *
 * Translates Claude Code CLI JSON output events to Tymbal protocol frames
 * and streams them to the Cikada API.
 *
 * Claude Code --output-format stream-json emits JSON lines like:
 * - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 * - {"type":"tool_use","tool_use_id":"...","name":"Read","input":{...}}
 * - {"type":"tool_result","tool_use_id":"...","content":"...","is_error":false}
 * - {"type":"result","result":"..."}
 * - {"type":"error","error":{"message":"..."}}
 */

// Content block types from Claude Code CLI
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
  content: unknown;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

// Claude Code CLI event types (from --output-format stream-json)
export interface ClaudeCodeEvent {
  type: "assistant" | "user" | "tool_use" | "tool_result" | "result" | "error" | "system";
  // Assistant or user message
  message?: {
    content: ContentBlock[];
  };
  // Tool use (legacy format)
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // Tool result (legacy format)
  content?: unknown;
  is_error?: boolean;
  // Result
  result?: unknown;
  // Error
  error?: {
    message: string;
  };
}

// ULID-like ID generation (simplified for container use)
function generateId(): string {
  const timestamp = Date.now().toString(36).padStart(10, "0");
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${random}`.toUpperCase();
}

export interface TymbalBridgeConfig {
  cikadaApiUrl: string;
  threadId: string;
  /** Agent callsign for sender attribution in frames */
  callsign?: string;
}

export interface TymbalFrame {
  i: string; // Message ID
  t?: string; // Timestamp (for set frames)
  m?: Record<string, unknown>; // Metadata (for start frames)
  a?: string; // Append content
  v?: unknown; // Set value (or null for delete)
}

export class TymbalBridge {
  private readonly apiUrl: string;
  private readonly threadId: string;
  private readonly callsign: string;
  private currentAssistantMsgId: string | null = null;
  private currentToolCallId: string | null = null;
  private assistantContent: string = "";

  constructor(config: TymbalBridgeConfig) {
    this.apiUrl = config.cikadaApiUrl;
    this.threadId = config.threadId;
    this.callsign = config.callsign ?? "claude-code";
  }

  /**
   * Process a Claude Code CLI event and emit appropriate Tymbal frames.
   */
  async processEvent(event: ClaudeCodeEvent): Promise<void> {
    if (event.type === "assistant") {
      await this.handleAssistant(event);
    } else if (event.type === "user") {
      await this.handleUser(event);
    } else if (event.type === "tool_use") {
      // Legacy format - tool_use as top-level event
      await this.handleToolUse(event);
    } else if (event.type === "tool_result") {
      // Legacy format - tool_result as top-level event
      await this.handleToolResult(event);
    } else if (event.type === "result") {
      await this.handleResult(event);
    } else if (event.type === "error") {
      await this.handleError(event);
    } else if (event.type === "system") {
      // Ignore system events
    } else {
      console.log(`[TymbalBridge] Unknown event type: ${(event as ClaudeCodeEvent).type}`);
    }
  }

  /**
   * Handle assistant events - extract text and tool_use blocks.
   * Tool use blocks are embedded in assistant message content.
   */
  private async handleAssistant(event: ClaudeCodeEvent): Promise<void> {
    const content = event.message?.content;
    if (!content) return;

    // Process each content block
    for (const block of content) {
      if (block.type === "text" && "text" in block) {
        // Handle text content - stream incrementally
        const textBlock = block as TextBlock;
        const newText = textBlock.text;

        if (newText.length > this.assistantContent.length) {
          const delta = newText.substring(this.assistantContent.length);

          // Generate ID upfront to ensure it's never null for append
          // This prevents race conditions where finalizeAssistantMessage()
          // could reset the ID between start and append frames
          const msgId = this.currentAssistantMsgId ?? generateId();
          const needsStart = !this.currentAssistantMsgId;
          this.currentAssistantMsgId = msgId;

          // Start frame (if this is a new message)
          if (needsStart) {
            await this.emitFrame({
              i: msgId,
              m: { type: "assistant", sender: this.callsign, senderType: "agent" },
            });
          }

          // Append delta - msgId is guaranteed non-null
          await this.emitFrame({
            i: msgId,
            a: delta,
          });

          this.assistantContent = newText;
        }
      } else if (block.type === "tool_use" && "id" in block && "name" in block) {
        // Handle embedded tool_use blocks
        const toolBlock = block as ToolUseBlock;

        // Finalize any pending assistant message first
        await this.finalizeAssistantMessage();

        const toolCallId = generateId();
        this.currentToolCallId = toolCallId;

        await this.emitFrame({
          i: toolCallId,
          t: new Date().toISOString(),
          v: {
            type: "tool_call",
            sender: this.callsign,
            senderType: "agent",
            id: toolBlock.id,
            name: toolBlock.name,
            args: toolBlock.input,
          },
        });
      }
    }
  }

  /**
   * Handle user events - extract tool_result blocks.
   * Tool results are embedded in user message content.
   */
  private async handleUser(event: ClaudeCodeEvent): Promise<void> {
    const content = event.message?.content;
    if (!content) return;

    for (const block of content) {
      if (block.type === "tool_result" && "tool_use_id" in block) {
        const resultBlock = block as ToolResultBlock;
        const resultId = generateId();

        // Determine result status and content
        const isError = resultBlock.is_error ?? false;
        let resultContent: unknown = resultBlock.content;

        // Extract text content if it's an array
        if (Array.isArray(resultContent)) {
          resultContent = resultContent
            .filter((item): item is { type: "text"; text: string } =>
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
            call_id: resultBlock.tool_use_id,
            content: resultContent,
            isError,
          },
        });
      }
    }
  }

  /**
   * Handle tool use events - emit tool_call frame.
   */
  private async handleToolUse(event: ClaudeCodeEvent): Promise<void> {
    // Finalize any pending assistant message
    await this.finalizeAssistantMessage();

    const toolCallId = generateId();
    this.currentToolCallId = toolCallId;

    await this.emitFrame({
      i: toolCallId,
      t: new Date().toISOString(),
      v: {
        type: "tool_call",
        sender: this.callsign,
        senderType: "agent",
        id: event.tool_use_id,
        name: event.name,
        args: event.input,
      },
    });
  }

  /**
   * Handle tool result events - emit tool_result frame.
   */
  private async handleToolResult(event: ClaudeCodeEvent): Promise<void> {
    const resultId = generateId();

    // Determine result status and content
    const isError = event.is_error ?? false;
    let content: unknown = event.content;

    // Extract text content if it's an array
    if (Array.isArray(content)) {
      content = content
        .filter((block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n");
    }

    await this.emitFrame({
      i: resultId,
      t: new Date().toISOString(),
      v: {
        type: "tool_result",
        sender: this.callsign,
        senderType: "agent",
        call_id: event.tool_use_id,
        name: event.name,
        content,
        isError,
      },
    });
  }

  /**
   * Handle completion result.
   */
  private async handleResult(event: ClaudeCodeEvent): Promise<void> {
    // Finalize any pending assistant message
    await this.finalizeAssistantMessage();

    const completeId = generateId();
    await this.emitFrame({
      i: completeId,
      t: new Date().toISOString(),
      v: {
        type: "agent_complete",
        sender: this.callsign,
        senderType: "agent",
        status: "success",
        result: event.result,
      },
    });
  }

  /**
   * Handle error events.
   */
  private async handleError(event: ClaudeCodeEvent): Promise<void> {
    const errorId = generateId();
    await this.emitFrame({
      i: errorId,
      t: new Date().toISOString(),
      v: {
        type: "agent_complete",
        sender: this.callsign,
        senderType: "agent",
        status: "error",
        message: event.error?.message ?? "Unknown error",
      },
    });
  }

  /**
   * Finalize pending assistant message with set frame.
   */
  private async finalizeAssistantMessage(): Promise<void> {
    if (this.currentAssistantMsgId && this.assistantContent) {
      await this.emitFrame({
        i: this.currentAssistantMsgId,
        t: new Date().toISOString(),
        v: {
          type: "assistant",
          sender: this.callsign,
          senderType: "agent",
          content: this.assistantContent,
        },
      });
    }

    // Reset state
    this.currentAssistantMsgId = null;
    this.assistantContent = "";
  }

  /**
   * Finalize any pending messages (call at end of conversation turn).
   */
  async finalize(): Promise<void> {
    await this.finalizeAssistantMessage();
  }

  /**
   * Emit a Tymbal frame to the Cikada API.
   */
  private async emitFrame(frame: TymbalFrame): Promise<void> {
    const frameJson = JSON.stringify(frame);
    console.log(`[Tymbal] ${frameJson}`);

    try {
      const response = await fetch(`${this.apiUrl}/thread/${this.threadId}/tymbal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
