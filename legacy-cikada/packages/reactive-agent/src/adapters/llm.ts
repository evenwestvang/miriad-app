/**
 * LLM Adapter Interface
 *
 * Abstracts LLM interactions for the reactive agent.
 * Implementations: Anthropic SDK (production), Mock (testing).
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Tool definition in Anthropic format.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Parameters for LLM streaming requests.
 */
export interface LLMStreamParams {
  /** Model identifier */
  model: string;
  /** System prompt */
  system?: string;
  /** Conversation messages */
  messages: LLMMessage[];
  /** Available tools */
  tools?: ToolDefinition[];
  /** Maximum tokens to generate */
  max_tokens?: number;
}

/**
 * Message in LLM conversation format.
 */
export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

/**
 * Content block types for complex messages.
 */
export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * Stream chunk types from the LLM.
 */
export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_use"; toolCall: { id: string; name: string; input: Record<string, unknown> } }
  | { type: "message_delta"; stopReason: StopReason }
  | { type: "content_block_start"; index: number; contentBlock: { type: string; id?: string; name?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; partial_json?: string } }
  | { type: "content_block_stop"; index: number };

/**
 * Reasons the LLM stopped generating.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

// =============================================================================
// LLM Adapter Interface
// =============================================================================

/**
 * LLM adapter interface for the reactive agent.
 *
 * Implementations:
 * - Anthropic: Real Claude API via @anthropic-ai/sdk
 * - Mock: Deterministic responses for testing
 */
export interface LLMAdapter {
  /**
   * Stream a response from the LLM.
   * Returns an async iterator of stream chunks.
   */
  stream(params: LLMStreamParams): AsyncIterable<StreamChunk>;
}
