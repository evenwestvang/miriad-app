/**
 * Mock LLM Adapter for Testing
 *
 * Provides a pluggable LLM interface for testing without API calls.
 * Supports:
 * - Canned responses with streaming simulation
 * - Tool call sequences
 * - Controllable delays
 * - Call logging for assertions
 */

import type { Message } from "@cikada/agent";

// =============================================================================
// Types
// =============================================================================

export interface StreamChunk {
  type: "text" | "tool_use" | "message_delta";
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
}

export interface MockResponse {
  /** Text content to return */
  text?: string;
  /** Tool calls to include in response */
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
  }>;
  /** Characters per chunk for streaming simulation */
  chunkSize?: number;
  /** Milliseconds between chunks */
  chunkDelay?: number;
  /** Stop reason for this response */
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
}

export interface MockLLMOptions {
  /** Base delay before responding (ms) */
  delay?: number;
  /** Default chunk size for streaming */
  defaultChunkSize?: number;
  /** Default chunk delay (ms) */
  defaultChunkDelay?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface LLMStreamOptions {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  max_tokens?: number;
}

/**
 * Pluggable LLM interface for testing and production.
 */
export interface LLMAdapter {
  stream(options: LLMStreamOptions): AsyncIterable<StreamChunk>;
}

// =============================================================================
// Mock Implementation
// =============================================================================

/**
 * Mock LLM for deterministic testing.
 * Queue responses, simulate streaming, track calls for assertions.
 */
export class MockLLMAdapter implements LLMAdapter {
  private responseQueue: MockResponse[] = [];
  private callLog: LLMStreamOptions[] = [];
  private options: Required<MockLLMOptions>;

  constructor(options: MockLLMOptions = {}) {
    this.options = {
      delay: options.delay ?? 0,
      defaultChunkSize: options.defaultChunkSize ?? 10,
      defaultChunkDelay: options.defaultChunkDelay ?? 0,
    };
  }

  /**
   * Queue a single response for the next stream() call.
   */
  queueResponse(response: MockResponse): this {
    this.responseQueue.push(response);
    return this;
  }

  /**
   * Queue multiple responses in order.
   */
  queueResponses(responses: MockResponse[]): this {
    this.responseQueue.push(...responses);
    return this;
  }

  /**
   * Get all calls made to this mock.
   */
  getCalls(): LLMStreamOptions[] {
    return [...this.callLog];
  }

  /**
   * Get the last call made to this mock.
   */
  getLastCall(): LLMStreamOptions | undefined {
    return this.callLog[this.callLog.length - 1];
  }

  /**
   * Get number of calls made.
   */
  getCallCount(): number {
    return this.callLog.length;
  }

  /**
   * Clear call log.
   */
  clearCalls(): this {
    this.callLog = [];
    return this;
  }

  /**
   * Clear queued responses.
   */
  clearResponses(): this {
    this.responseQueue = [];
    return this;
  }

  /**
   * Reset mock to initial state.
   */
  reset(): this {
    this.callLog = [];
    this.responseQueue = [];
    return this;
  }

  /**
   * Stream a response, simulating the Anthropic streaming API.
   */
  async *stream(options: LLMStreamOptions): AsyncIterable<StreamChunk> {
    this.callLog.push(options);

    // Get next queued response or default
    const response = this.responseQueue.shift() ?? {
      text: "No response queued",
      stopReason: "end_turn" as const,
    };

    // Simulate initial delay
    if (this.options.delay > 0) {
      await delay(this.options.delay);
    }

    // Stream text content in chunks
    if (response.text) {
      const chunkSize = response.chunkSize ?? this.options.defaultChunkSize;
      const chunkDelay = response.chunkDelay ?? this.options.defaultChunkDelay;
      const chunks = chunkString(response.text, chunkSize);

      for (const chunk of chunks) {
        yield { type: "text", content: chunk };

        if (chunkDelay > 0) {
          await delay(chunkDelay);
        }
      }
    }

    // Yield tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const toolCall of response.toolCalls) {
        yield {
          type: "tool_use",
          toolCall: {
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
          },
        };
      }
    }

    // Yield final message delta with stop reason
    const stopReason = response.toolCalls?.length
      ? "tool_use"
      : response.stopReason ?? "end_turn";

    yield {
      type: "message_delta",
      stopReason,
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkString(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock response with text only.
 */
export function mockTextResponse(text: string): MockResponse {
  return { text, stopReason: "end_turn" };
}

/**
 * Create a mock response with a tool call.
 */
export function mockToolCall(
  name: string,
  input: unknown,
  id?: string
): MockResponse {
  return {
    text: "",
    toolCalls: [
      {
        id: id ?? `tool_${Date.now()}`,
        name,
        input,
      },
    ],
    stopReason: "tool_use",
  };
}

/**
 * Create a mock response with text and tool call.
 */
export function mockTextWithToolCall(
  text: string,
  toolName: string,
  toolInput: unknown,
  toolId?: string
): MockResponse {
  return {
    text,
    toolCalls: [
      {
        id: toolId ?? `tool_${Date.now()}`,
        name: toolName,
        input: toolInput,
      },
    ],
    stopReason: "tool_use",
  };
}

/**
 * Create a sequence of responses for a tool use loop.
 * First response includes tool call, second is final response after tool result.
 */
export function mockToolUseSequence(
  toolName: string,
  toolInput: unknown,
  finalResponse: string,
  toolId?: string
): MockResponse[] {
  const id = toolId ?? `tool_${Date.now()}`;
  return [
    {
      text: `Using ${toolName}...`,
      toolCalls: [{ id, name: toolName, input: toolInput }],
      stopReason: "tool_use",
    },
    {
      text: finalResponse,
      stopReason: "end_turn",
    },
  ];
}
