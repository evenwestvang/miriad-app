import { describe, it, expect, beforeEach } from "vitest";
import { defineAgent } from "@cikada/agent";
import { MockLLMAdapter, mockTextResponse } from "@cikada/local-runtime";
import { createAgentRunner, MessageStore, ArtifactStore } from "../index.js";

describe("AgentRunner", () => {
  let messageStore: MessageStore;
  let artifactStore: ArtifactStore;

  beforeEach(() => {
    messageStore = new MessageStore();
    artifactStore = new ArtifactStore();
  });

  it("should run a simple agent and capture response", async () => {
    const mockLLM = new MockLLMAdapter();
    mockLLM.queueResponse(mockTextResponse("Hello! I'm here to help."));

    const runner = createAgentRunner({
      llm: mockLLM,
      messageStore,
      artifactStore,
      channel: "test",
      agentName: "test-agent",
    });

    const agent = defineAgent({
      system: "You are a helpful assistant.",
    });

    const result = await runner.run({
      agent,
      userMessage: "Hello!",
    });

    // Should have captured the assistant message
    expect(result.messages.length).toBeGreaterThan(0);

    // Check the LLM was called
    expect(mockLLM.getCallCount()).toBe(1);
    const lastCall = mockLLM.getLastCall();
    expect(lastCall?.system).toBe("You are a helpful assistant.");
  });

  it("should support queueResponse helper method", async () => {
    const runner = createAgentRunner({
      messageStore,
      artifactStore,
      channel: "test",
      agentName: "test-agent",
    });

    // Queue response using helper
    runner.queueResponse("This is the mocked response.");

    const agent = defineAgent({
      system: "You are a test agent.",
    });

    const result = await runner.run({
      agent,
      userMessage: "Test message",
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("should store messages in the message store", async () => {
    const mockLLM = new MockLLMAdapter();
    mockLLM.queueResponse(mockTextResponse("Response from agent."));

    const runner = createAgentRunner({
      llm: mockLLM,
      messageStore,
      artifactStore,
      channel: "test-channel",
      agentName: "my-agent",
    });

    const agent = defineAgent({
      system: "Test system prompt.",
    });

    await runner.run({
      agent,
      userMessage: "Hello there!",
    });

    // Check message was stored
    const messages = messageStore.getAll("test-channel");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].sender).toBe("my-agent");
  });

  it("should handle agents with no response gracefully", async () => {
    const mockLLM = new MockLLMAdapter();
    // Queue a response with no text (just tool use or empty)
    mockLLM.queueResponse({ text: "", stopReason: "end_turn" });

    const runner = createAgentRunner({
      llm: mockLLM,
      messageStore,
      artifactStore,
      channel: "test",
      agentName: "test-agent",
    });

    const agent = defineAgent({
      system: "Quiet agent.",
    });

    // Should not throw
    const result = await runner.run({
      agent,
      userMessage: "Say nothing",
    });

    // Empty response means no messages captured (no text to broadcast)
    expect(result.messages.length).toBe(0);
  });
});
