/**
 * Testing Utilities
 *
 * Provides mock implementations and test helpers for local-runtime testing.
 */

export {
  MockLLMAdapter,
  mockTextResponse,
  mockToolCall,
  mockTextWithToolCall,
  mockToolUseSequence,
  type LLMAdapter,
  type LLMStreamOptions,
  type StreamChunk,
  type MockResponse,
  type MockLLMOptions,
  type ToolDefinition,
} from "./mock-llm.js";

export {
  AnthropicLLMAdapter,
  createAnthropicAdapter,
  type AnthropicAdapterOptions,
} from "./anthropic-adapter.js";
