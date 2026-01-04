/**
 * Tests for runReactiveAgent()
 *
 * Uses mock adapters to test the core agentic loop in isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { runReactiveAgent } from "../reactive-loop.js";
import type { StorageAdapter } from "../adapters/storage.js";
import type { BroadcastAdapter } from "../adapters/broadcast.js";
import type { LLMAdapter, StreamChunk } from "../adapters/llm.js";
import type { ToolAdapter } from "../adapters/tools.js";
import type { StoredMessage } from "@cikada/core";

// =============================================================================
// Mock Adapters
// =============================================================================

function createMockStorage(history: StoredMessage[] = []): StorageAdapter {
  const savedMessages: unknown[] = [];

  return {
    async getAgentHistory() {
      return history;
    },
    async saveMessage(_spaceId, message) {
      savedMessages.push(message);
    },
    async updateMessage() {
      // No-op for tests
    },
    // Expose for assertions
    _savedMessages: savedMessages,
  } as StorageAdapter & { _savedMessages: unknown[] };
}

function createMockBroadcast(): BroadcastAdapter & { _frames: string[] } {
  const frames: string[] = [];

  return {
    async broadcast(frame: string) {
      frames.push(frame);
    },
    async hasListeners() {
      return true;
    },
    _frames: frames,
  };
}

function createMockLLM(
  responses: Array<{ text?: string; toolUse?: { id: string; name: string; input: Record<string, unknown> }; stopReason: string }>
): LLMAdapter {
  let callIndex = 0;

  return {
    async *stream(): AsyncIterable<StreamChunk> {
      const response = responses[callIndex++];
      if (!response) {
        throw new Error("No more mock responses");
      }

      if (response.text) {
        yield { type: "text", content: response.text };
      }

      if (response.toolUse) {
        yield {
          type: "tool_use",
          toolCall: response.toolUse,
        };
      }

      yield { type: "message_delta", stopReason: response.stopReason as "end_turn" | "tool_use" };
    },
  };
}

function createMockTools(): ToolAdapter {
  return {
    async getTools() {
      return [
        {
          name: "test_tool",
          description: "A test tool",
          input_schema: { type: "object", properties: {} },
        },
      ];
    },
    async execute(name: string, args: Record<string, unknown>) {
      return {
        isError: false,
        content: `Tool ${name} executed with args: ${JSON.stringify(args)}`,
      };
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("runReactiveAgent", () => {
  it("should complete a simple text response", async () => {
    const storage = createMockStorage();
    const broadcast = createMockBroadcast();
    const llm = createMockLLM([
      { text: "Hello! How can I help you?", stopReason: "end_turn" },
    ]);

    const result = await runReactiveAgent({
      spaceId: "test-space",
      channelId: "test-channel",
      agentCallsign: "test-agent",
      sinceTimestamp: new Date().toISOString(),
      userMessage: "Hi!",
      systemPrompt: "You are a helpful assistant.",
      storage,
      broadcast,
      llm,
    });

    expect(result.response).toBe("Hello! How can I help you?");
    expect(result.numTurns).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Should have broadcast frames
    expect(broadcast._frames.length).toBeGreaterThan(0);
  });

  it("should handle tool calls and continue the loop", async () => {
    const storage = createMockStorage();
    const broadcast = createMockBroadcast();
    const tools = createMockTools();

    // First response: tool call, second response: text
    const llm = createMockLLM([
      {
        text: "Let me check that for you.",
        toolUse: { id: "tool-1", name: "test_tool", input: { query: "test" } },
        stopReason: "tool_use",
      },
      { text: "Based on the tool result, here is your answer.", stopReason: "end_turn" },
    ]);

    const result = await runReactiveAgent({
      spaceId: "test-space",
      channelId: "test-channel",
      agentCallsign: "test-agent",
      sinceTimestamp: new Date().toISOString(),
      userMessage: "What is the answer?",
      systemPrompt: "You are a helpful assistant.",
      storage,
      broadcast,
      llm,
      tools,
    });

    expect(result.response).toBe("Based on the tool result, here is your answer.");
    expect(result.numTurns).toBe(2); // One turn with tool call, one turn with final response
  });

  it("should respect maxTurns limit", async () => {
    const storage = createMockStorage();
    const broadcast = createMockBroadcast();
    const tools = createMockTools();

    // Always return tool calls - would loop forever without maxTurns
    const infiniteToolCalls = Array(10).fill({
      toolUse: { id: "tool-x", name: "test_tool", input: {} },
      stopReason: "tool_use",
    });

    const llm = createMockLLM(infiniteToolCalls);

    const result = await runReactiveAgent({
      spaceId: "test-space",
      channelId: "test-channel",
      agentCallsign: "test-agent",
      sinceTimestamp: new Date().toISOString(),
      userMessage: "Loop forever",
      systemPrompt: "You are a helpful assistant.",
      storage,
      broadcast,
      llm,
      tools,
      maxTurns: 3,
    });

    expect(result.numTurns).toBe(3);
  });

  it("should load and use conversation history", async () => {
    const history: StoredMessage[] = [
      {
        id: "msg-1",
        channelId: "test-channel",
        timestamp: new Date().toISOString(),
        type: "text",
        senderType: "user",
        sender: "user",
        content: { text: "Previous message" },
        addressedAgents: ["channel"],
      },
    ];

    const storage = createMockStorage(history);
    const broadcast = createMockBroadcast();
    const llm = createMockLLM([
      { text: "I remember the previous message!", stopReason: "end_turn" },
    ]);

    const result = await runReactiveAgent({
      spaceId: "test-space",
      channelId: "test-channel",
      agentCallsign: "test-agent",
      sinceTimestamp: new Date(0).toISOString(),
      userMessage: "Do you remember?",
      systemPrompt: "You are a helpful assistant.",
      storage,
      broadcast,
      llm,
    });

    expect(result.response).toBe("I remember the previous message!");
  });

  it("should save messages to storage", async () => {
    const storage = createMockStorage() as StorageAdapter & { _savedMessages: unknown[] };
    const broadcast = createMockBroadcast();
    const llm = createMockLLM([
      { text: "Saved response", stopReason: "end_turn" },
    ]);

    await runReactiveAgent({
      spaceId: "test-space",
      channelId: "test-channel",
      agentCallsign: "test-agent",
      sinceTimestamp: new Date().toISOString(),
      userMessage: "Save this",
      systemPrompt: "You are a helpful assistant.",
      storage,
      broadcast,
      llm,
    });

    // Should have saved messages (assistant response + completion)
    expect(storage._savedMessages.length).toBeGreaterThan(0);
  });
});
