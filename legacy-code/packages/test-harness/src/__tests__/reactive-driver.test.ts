/**
 * Reactive Driver Integration Tests
 *
 * Tests the reactive driver through the test harness to verify:
 * - Basic agent execution with no MCP
 * - Tool registration and namespacing
 * - Agent tool execution
 * - Tool call sequences
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "@cikada/agent";
import {
  MockLLMAdapter,
  mockTextResponse,
  mockToolCall,
  mockToolUseSequence,
} from "@cikada/local-runtime";
import { createAgentRunner, MessageStore, ArtifactStore } from "../index.js";

describe("ReactiveDriver Integration", () => {
  let messageStore: MessageStore;
  let artifactStore: ArtifactStore;

  beforeEach(() => {
    messageStore = new MessageStore();
    artifactStore = new ArtifactStore();
  });

  describe("basic agent execution", () => {
    it("should run a simple agent without tools", async () => {
      const mockLLM = new MockLLMAdapter();
      mockLLM.queueResponse(mockTextResponse("Hello! How can I help you today?"));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "assistant",
      });

      const agent = defineAgent({
        system: "You are a helpful assistant.",
      });

      const result = await runner.run({
        agent,
        userMessage: "Hello!",
      });

      expect(result.messages.length).toBeGreaterThan(0);
      expect(mockLLM.getCallCount()).toBe(1);

      const lastCall = mockLLM.getLastCall();
      expect(lastCall?.system).toBe("You are a helpful assistant.");
      expect(lastCall?.messages.length).toBe(1);
      expect(lastCall?.messages[0].role).toBe("user");
    });

    it("should include model from agent config", async () => {
      const mockLLM = new MockLLMAdapter();
      mockLLM.queueResponse(mockTextResponse("Response"));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "assistant",
      });

      const agent = defineAgent({
        system: "Test agent",
        config: {
          model: "claude-3-opus-latest",
        },
      });

      await runner.run({ agent, userMessage: "Test" });

      const lastCall = mockLLM.getLastCall();
      expect(lastCall?.model).toBe("claude-3-opus-latest");
    });
  });

  describe("agent tool execution", () => {
    it("should execute agent-defined tools", async () => {
      const mockLLM = new MockLLMAdapter();

      // Queue: first LLM call returns tool use, second returns final text
      mockLLM.queueResponses(
        mockToolUseSequence("get_time", {}, "The current time is 12:00 PM.")
      );

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "time-agent",
      });

      const agent = defineAgent({
        system: "You can tell the time.",
        tools: {
          get_time: defineTool({
            description: "Get the current time",
            parameters: z.object({}),
            execute: async () => {
              return { time: "12:00 PM" };
            },
          }),
        },
      });

      const result = await runner.run({
        agent,
        userMessage: "What time is it?",
      });

      // Should have called LLM twice (tool call + final response)
      expect(mockLLM.getCallCount()).toBe(2);
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it("should pass tool arguments correctly", async () => {
      const mockLLM = new MockLLMAdapter();

      // Queue tool call with arguments
      mockLLM.queueResponse({
        text: "Calculating...",
        toolCalls: [
          {
            id: "calc_1",
            name: "add",
            input: { a: 5, b: 3 },
          },
        ],
        stopReason: "tool_use",
      });
      mockLLM.queueResponse(mockTextResponse("The result is 8."));

      let capturedArgs: { a: number; b: number } | null = null;

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "calculator",
      });

      const agent = defineAgent({
        system: "You are a calculator.",
        tools: {
          add: defineTool({
            description: "Add two numbers",
            parameters: z.object({
              a: z.number(),
              b: z.number(),
            }),
            execute: async (args) => {
              capturedArgs = args;
              return { result: args.a + args.b };
            },
          }),
        },
      });

      await runner.run({
        agent,
        userMessage: "Add 5 and 3",
      });

      expect(capturedArgs).toEqual({ a: 5, b: 3 });
    });

    it("should handle tool execution errors gracefully", async () => {
      const mockLLM = new MockLLMAdapter();

      mockLLM.queueResponse({
        text: "",
        toolCalls: [
          {
            id: "fail_1",
            name: "failing_tool",
            input: {},
          },
        ],
        stopReason: "tool_use",
      });
      mockLLM.queueResponse(mockTextResponse("I encountered an error."));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "test-agent",
      });

      const agent = defineAgent({
        system: "Test agent",
        tools: {
          failing_tool: defineTool({
            description: "A tool that fails",
            parameters: z.object({}),
            execute: async () => {
              throw new Error("Intentional failure");
            },
          }),
        },
      });

      // Should not throw
      const result = await runner.run({
        agent,
        userMessage: "Use the failing tool",
      });

      expect(mockLLM.getCallCount()).toBe(2);
      expect(result.messages).toBeDefined();
    });

    it("should handle unknown tool gracefully", async () => {
      const mockLLM = new MockLLMAdapter();

      mockLLM.queueResponse({
        text: "",
        toolCalls: [
          {
            id: "unknown_1",
            name: "nonexistent_tool",
            input: {},
          },
        ],
        stopReason: "tool_use",
      });
      mockLLM.queueResponse(mockTextResponse("That tool doesn't exist."));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "test-agent",
      });

      const agent = defineAgent({
        system: "Test agent",
        // No tools defined
      });

      // Should not throw, should recover gracefully
      await runner.run({
        agent,
        userMessage: "Use a nonexistent tool",
      });

      expect(mockLLM.getCallCount()).toBe(2);
    });
  });

  describe("multiple tool calls", () => {
    it("should execute multiple tools in sequence", async () => {
      const mockLLM = new MockLLMAdapter();
      const callOrder: string[] = [];

      // First response: two tool calls
      mockLLM.queueResponse({
        text: "Let me help with that.",
        toolCalls: [
          { id: "t1", name: "step_one", input: {} },
          { id: "t2", name: "step_two", input: {} },
        ],
        stopReason: "tool_use",
      });
      // After tools: final response
      mockLLM.queueResponse(mockTextResponse("Done with both steps."));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "test",
        agentName: "multi-tool-agent",
      });

      const agent = defineAgent({
        system: "Multi-step agent",
        tools: {
          step_one: defineTool({
            description: "First step",
            parameters: z.object({}),
            execute: async () => {
              callOrder.push("step_one");
              return { status: "step_one complete" };
            },
          }),
          step_two: defineTool({
            description: "Second step",
            parameters: z.object({}),
            execute: async () => {
              callOrder.push("step_two");
              return { status: "step_two complete" };
            },
          }),
        },
      });

      await runner.run({
        agent,
        userMessage: "Do both steps",
      });

      // Both tools should have been called
      expect(callOrder).toContain("step_one");
      expect(callOrder).toContain("step_two");
      expect(callOrder.length).toBe(2);
    });
  });

  describe("message store integration", () => {
    it("should store assistant messages in the message store", async () => {
      const mockLLM = new MockLLMAdapter();
      mockLLM.queueResponse(mockTextResponse("Stored response"));

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "harness-channel",
        agentName: "storing-agent",
      });

      const agent = defineAgent({
        system: "Test agent",
      });

      await runner.run({
        agent,
        userMessage: "Test",
      });

      const messages = messageStore.getAll("harness-channel");
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].sender).toBe("storing-agent");
      expect(messages[0].channel).toBe("harness-channel");
    });

    it("should store tool results as messages", async () => {
      const mockLLM = new MockLLMAdapter();
      mockLLM.queueResponses(
        mockToolUseSequence("test_tool", {}, "Final response")
      );

      const runner = createAgentRunner({
        llm: mockLLM,
        messageStore,
        artifactStore,
        channel: "tool-channel",
        agentName: "tool-agent",
      });

      const agent = defineAgent({
        system: "Test",
        tools: {
          test_tool: defineTool({
            description: "Test tool",
            parameters: z.object({}),
            execute: async () => ({ result: "tool output" }),
          }),
        },
      });

      await runner.run({
        agent,
        userMessage: "Use the tool",
      });

      const messages = messageStore.getAll("tool-channel");
      // Should have multiple messages (tool result + assistant responses)
      expect(messages.length).toBeGreaterThan(1);
    });
  });
});
