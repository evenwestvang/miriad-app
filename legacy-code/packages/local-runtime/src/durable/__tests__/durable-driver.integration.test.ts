/**
 * Integration Tests for Durable Driver
 *
 * Tests the full agentic loop with:
 * - Mock LLM adapter
 * - Durable context checkpointing
 * - Tool execution
 * - Recovery after simulated crash
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { z } from "zod";
import { defineAgent, defineWorkflow, defineTool } from "@cikada/agent";
import { DurableSqliteStorage } from "../sqlite-storage.js";
import { createLocalDurableContext } from "../durable-context.js";
import { createDurableDriver } from "../durable-driver.js";
import {
  MockLLMAdapter,
  mockTextResponse,
  mockToolCall,
  mockToolUseSequence,
} from "../../testing/mock-llm.js";
import { storage } from "../../storage.js";

describe("DurableDriver Integration", () => {
  let mockLLM: MockLLMAdapter;
  let durableStorage: DurableSqliteStorage;
  let emitter: EventEmitter;
  let broadcastedFrames: string[];

  beforeEach(async () => {
    mockLLM = new MockLLMAdapter({ delay: 0 });
    durableStorage = new DurableSqliteStorage(":memory:");
    emitter = new EventEmitter();
    broadcastedFrames = [];

    // Initialize in-memory thread storage
    await storage.createThread("test-thread", "test-agent");
  });

  afterEach(() => {
    durableStorage.close();
    storage.clear();
  });

  const broadcast = async (frame: string): Promise<void> => {
    broadcastedFrames.push(frame);
  };

  // ---------------------------------------------------------------------------
  // Basic Agent Tests
  // ---------------------------------------------------------------------------

  describe("basic agent execution", () => {
    it("completes simple text response", async () => {
      mockLLM.queueResponse(mockTextResponse("Hello! I'm here to help."));

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-agent",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      const agent = defineAgent({
        name: "test-agent",
        system: "You are a helpful assistant.",
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-agent",
        userMessage: "Hello!",
        agent,
        broadcast,
      });

      // Verify LLM was called
      expect(mockLLM.getCallCount()).toBe(1);

      // Verify response was broadcast
      const frames = broadcastedFrames.map((f) => JSON.parse(f));
      const assistantFrame = frames.find((f) => f.v?.type === "assistant");
      expect(assistantFrame?.v?.content).toBe("Hello! I'm here to help.");
    });

    it("executes tool calls in agentic loop", async () => {
      // Queue: tool call response, then final response
      mockLLM.queueResponses(
        mockToolUseSequence("get_time", { timezone: "UTC" }, "The time is 12:00 UTC.")
      );

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-agent",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      const agent = defineAgent({
        name: "test-agent",
        system: "You are a helpful assistant.",
        tools: {
          get_time: defineTool({
            description: "Get current time",
            parameters: z.object({
              timezone: z.string().optional(),
            }),
            execute: async (args) => ({
              time: "12:00",
              timezone: args.timezone ?? "UTC",
            }),
          }),
        },
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-agent",
        userMessage: "What time is it?",
        agent,
        broadcast,
      });

      // Verify LLM was called twice (tool call + final response)
      expect(mockLLM.getCallCount()).toBe(2);

      // Verify tool result was broadcast
      const frames = broadcastedFrames.map((f) => JSON.parse(f));
      const toolResultFrame = frames.find((f) => f.v?.type === "tool_result");
      expect(toolResultFrame?.v?.toolName).toBe("get_time");
      expect(toolResultFrame?.v?.content).toEqual({ time: "12:00", timezone: "UTC" });

      // Verify final response
      const assistantFrames = frames.filter((f) => f.v?.type === "assistant");
      const finalFrame = assistantFrames[assistantFrames.length - 1];
      expect(finalFrame?.v?.content).toBe("The time is 12:00 UTC.");
    });
  });

  // ---------------------------------------------------------------------------
  // Durable Step Tests
  // ---------------------------------------------------------------------------

  describe("durable step checkpointing", () => {
    it("checkpoints LLM calls", async () => {
      mockLLM.queueResponse(mockTextResponse("Response 1"));

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-agent",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      const agent = defineAgent({
        name: "test-agent",
        system: "Test",
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-agent",
        userMessage: "Test",
        agent,
        broadcast,
      });

      // Verify checkpoint was created
      const checkpoints = durableStorage.getCheckpoints(durableContext.executionId);
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints[0].stepName).toMatch(/^llm-step-/);
    });

    it("checkpoints tool executions", async () => {
      mockLLM.queueResponses(mockToolUseSequence("test_tool", {}, "Done."));

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-agent",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      const agent = defineAgent({
        name: "test-agent",
        system: "Test",
        tools: {
          test_tool: defineTool({
            description: "Test tool",
            parameters: z.object({}),
            execute: async () => ({ result: "success" }),
          }),
        },
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-agent",
        userMessage: "Test",
        agent,
        broadcast,
      });

      // Verify tool checkpoint was created
      const checkpoints = durableStorage.getCheckpoints(durableContext.executionId);
      const toolCheckpoint = checkpoints.find((c) => c.stepName.startsWith("tool-"));
      expect(toolCheckpoint).toBeDefined();
      expect(toolCheckpoint?.stepName).toMatch(/^tool-test_tool-/);
    });
  });

  // ---------------------------------------------------------------------------
  // Workflow Tests
  // ---------------------------------------------------------------------------

  describe("workflow execution", () => {
    it("runs workflow with custom steps", async () => {
      const executionLog: string[] = [];

      const workflow = defineWorkflow({
        name: "test-workflow",
        system: "Test workflow",
        async onFlow(ctx) {
          const step1 = await ctx.step("custom-step-1", async () => {
            executionLog.push("step-1");
            return "result-1";
          });

          const step2 = await ctx.step("custom-step-2", async () => {
            executionLog.push("step-2");
            return "result-2";
          });

          return { step1, step2 };
        },
      });

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-workflow",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-workflow",
        userMessage: "run",
        agent: workflow,
        broadcast,
      });

      expect(executionLog).toEqual(["step-1", "step-2"]);

      // Verify completion
      const execution = durableStorage.getExecutionById(durableContext.executionId);
      expect(execution?.status).toBe("completed");
    });

    it("runs workflow with parallel execution", async () => {
      const workflow = defineWorkflow({
        name: "parallel-workflow",
        system: "Test",
        async onFlow(ctx) {
          const results = await ctx.parallel("parallel-tasks", [
            async () => "task-a",
            async () => "task-b",
            async () => "task-c",
          ]);
          return results;
        },
      });

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "parallel-workflow",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "parallel-workflow",
        userMessage: "run",
        agent: workflow,
        broadcast,
      });

      // Verify parallel checkpoint
      const checkpoints = durableStorage.getCheckpoints(durableContext.executionId);
      const parallelCheckpoint = checkpoints.find((c) => c.stepName === "parallel-tasks");
      expect(parallelCheckpoint).toBeDefined();
      expect(JSON.parse(parallelCheckpoint!.resultJson!)).toEqual(["task-a", "task-b", "task-c"]);
    });

    it("runs workflow with map operation", async () => {
      const workflow = defineWorkflow({
        name: "map-workflow",
        system: "Test",
        async onFlow(ctx) {
          const results = await ctx.map(
            "map-items",
            [1, 2, 3],
            async (item) => item * 10,
            { maxConcurrency: 2 }
          );
          return results;
        },
      });

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "map-workflow",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "map-workflow",
        userMessage: "run",
        agent: workflow,
        broadcast,
      });

      // Verify map checkpoint
      const checkpoints = durableStorage.getCheckpoints(durableContext.executionId);
      const mapCheckpoint = checkpoints.find((c) => c.stepName === "map-items");
      expect(mapCheckpoint).toBeDefined();
      expect(JSON.parse(mapCheckpoint!.resultJson!)).toEqual([10, 20, 30]);
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery Tests
  // ---------------------------------------------------------------------------

  describe("crash recovery", () => {
    it("skips completed steps on resume", async () => {
      const executionLog: string[] = [];

      // First run - complete step 1
      const durableContext1 = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "recovery-thread",
        agentName: "recovery-agent",
        callbackEmitter: emitter,
      });

      const workflow = defineWorkflow({
        name: "recovery-workflow",
        system: "Test",
        async onFlow(ctx) {
          const step1 = await ctx.step("step-1", async () => {
            executionLog.push("step-1-executed");
            return "result-1";
          });

          const step2 = await ctx.step("step-2", async () => {
            executionLog.push("step-2-executed");
            return "result-2";
          });

          return { step1, step2 };
        },
      });

      // Create thread for this test
      await storage.createThread("recovery-thread", "recovery-agent");

      const driver1 = createDurableDriver({
        llm: mockLLM,
        durableContext: durableContext1,
      });

      // Simulate crash after step-1 by manually saving only step-1 checkpoint
      await durableContext1.step("step-1", async () => {
        executionLog.push("step-1-first-run");
        return "result-1";
      });

      // Clear log to track second run
      executionLog.length = 0;

      // Second run - should skip step 1, execute step 2
      const durableContext2 = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "recovery-thread",
        agentName: "recovery-agent",
        callbackEmitter: emitter,
      });

      expect(durableContext2.isResuming).toBe(true);

      const driver2 = createDurableDriver({
        llm: mockLLM,
        durableContext: durableContext2,
      });

      await driver2.run({
        threadId: "recovery-thread",
        agentName: "recovery-agent",
        userMessage: "run",
        agent: workflow,
        broadcast,
      });

      // step-1 should NOT be in log (cached), only step-2
      expect(executionLog).not.toContain("step-1-executed");
      expect(executionLog).toContain("step-2-executed");
    });

    it("recovers partial map progress", async () => {
      const processedItems: number[] = [];

      // First run - process 2 items then "crash"
      const durableContext1 = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "map-recovery-thread",
        agentName: "map-recovery-agent",
        callbackEmitter: emitter,
      });

      await storage.createThread("map-recovery-thread", "map-recovery-agent");

      // Manually save partial progress (items 0 and 1)
      durableStorage.saveMapProgress(durableContext1.executionId, "items", 0, 10);
      durableStorage.saveMapProgress(durableContext1.executionId, "items", 1, 20);

      // Second run - should only process remaining items
      const durableContext2 = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "map-recovery-thread",
        agentName: "map-recovery-agent",
        callbackEmitter: emitter,
      });

      const workflow = defineWorkflow({
        name: "map-recovery",
        system: "Test",
        async onFlow(ctx) {
          return ctx.map("items", [1, 2, 3, 4], async (item, index) => {
            processedItems.push(item);
            return item * 10;
          });
        },
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext: durableContext2,
      });

      await driver.run({
        threadId: "map-recovery-thread",
        agentName: "map-recovery-agent",
        userMessage: "run",
        agent: workflow,
        broadcast,
      });

      // Only items 3 and 4 should have been processed (indices 2 and 3)
      expect(processedItems).toEqual([3, 4]);
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling Tests
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("marks execution as error on failure", async () => {
      const workflow = defineWorkflow({
        name: "error-workflow",
        system: "Test",
        async onFlow() {
          throw new Error("Intentional test error");
        },
      });

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "error-thread",
        agentName: "error-agent",
        callbackEmitter: emitter,
      });

      await storage.createThread("error-thread", "error-agent");

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      await expect(
        driver.run({
          threadId: "error-thread",
          agentName: "error-agent",
          userMessage: "run",
          agent: workflow,
          broadcast,
        })
      ).rejects.toThrow("Intentional test error");

      // Verify error status
      const execution = durableStorage.getExecutionById(durableContext.executionId);
      expect(execution?.status).toBe("error");
      expect(execution?.error).toBe("Intentional test error");
    });

    it("handles tool execution errors", async () => {
      mockLLM.queueResponses([
        {
          text: "Let me try that tool.",
          toolCalls: [{ id: "tc1", name: "failing_tool", input: {} }],
        },
        mockTextResponse("The tool failed, but I handled it."),
      ]);

      const durableContext = await createLocalDurableContext({
        storage: durableStorage,
        threadId: "test-thread",
        agentName: "test-agent",
        callbackEmitter: emitter,
      });

      const driver = createDurableDriver({
        llm: mockLLM,
        durableContext,
      });

      const agent = defineAgent({
        name: "test-agent",
        system: "Test",
        tools: {
          failing_tool: defineTool({
            description: "A tool that fails",
            parameters: z.object({}),
            execute: async () => {
              throw new Error("Tool execution failed");
            },
          }),
        },
      });

      await driver.run({
        threadId: "test-thread",
        agentName: "test-agent",
        userMessage: "Test",
        agent,
        broadcast,
      });

      // Should complete despite tool error (error returned to LLM)
      // Verify we got 2 LLM calls (tool call + after error response)
      expect(mockLLM.getCallCount()).toBe(2);

      // Verify final response came through
      const frames = broadcastedFrames.map((f) => JSON.parse(f));
      const assistantFrames = frames.filter((f) => f.v?.type === "assistant");
      expect(assistantFrames.length).toBeGreaterThanOrEqual(2);
    });
  });
});
