/**
 * Unit Tests for LocalDurableContext
 *
 * Tests core durability primitives:
 * - step() caching and recovery
 * - parallel() execution and checkpointing
 * - map() incremental progress
 * - waitForCallback() blocking and resolution
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { DurableSqliteStorage } from "../sqlite-storage.js";
import {
  createLocalDurableContext,
  resolveCallback,
  type DurableContext,
} from "../durable-context.js";

describe("LocalDurableContext", () => {
  let storage: DurableSqliteStorage;
  let emitter: EventEmitter;

  beforeEach(() => {
    // Use in-memory database for tests
    storage = new DurableSqliteStorage(":memory:");
    emitter = new EventEmitter();
  });

  afterEach(() => {
    storage.close();
  });

  // ---------------------------------------------------------------------------
  // step() tests
  // ---------------------------------------------------------------------------

  describe("step()", () => {
    it("executes function and checkpoints result", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let callCount = 0;
      const result = await ctx.step("test-step", async () => {
        callCount++;
        return { value: 42 };
      });

      expect(result).toEqual({ value: 42 });
      expect(callCount).toBe(1);

      // Verify checkpoint exists
      const checkpoints = storage.getCheckpoints(ctx.executionId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].stepName).toBe("test-step");
      expect(JSON.parse(checkpoints[0].resultJson!)).toEqual({ value: 42 });
    });

    it("skips execution on resume and returns cached result", async () => {
      // First execution
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });
      await ctx1.step("expensive-step", async () => ({ computed: "first-run" }));

      // Simulate restart - create new context for same thread/agent
      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let callCount = 0;
      const result = await ctx2.step("expensive-step", async () => {
        callCount++;
        return { computed: "second-run" };
      });

      // Should return cached result, not re-execute
      expect(result).toEqual({ computed: "first-run" });
      expect(callCount).toBe(0);
      expect(ctx2.isResuming).toBe(true);
    });

    it("executes multiple steps in order", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const order: string[] = [];

      await ctx.step("step-1", async () => {
        order.push("step-1");
        return "result-1";
      });

      await ctx.step("step-2", async () => {
        order.push("step-2");
        return "result-2";
      });

      expect(order).toEqual(["step-1", "step-2"]);

      // Verify both checkpoints exist
      const checkpoints = storage.getCheckpoints(ctx.executionId);
      expect(checkpoints).toHaveLength(2);
    });

    it("resumes from correct step after restart", async () => {
      // First execution - complete step 1
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      await ctx1.step("step-1", async () => "result-1");
      // Simulate crash before step-2

      // Second execution - should skip step 1, execute step 2
      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const executed: string[] = [];

      const r1 = await ctx2.step("step-1", async () => {
        executed.push("step-1");
        return "new-result-1";
      });

      const r2 = await ctx2.step("step-2", async () => {
        executed.push("step-2");
        return "result-2";
      });

      expect(r1).toBe("result-1"); // Cached
      expect(r2).toBe("result-2"); // Newly executed
      expect(executed).toEqual(["step-2"]); // Only step-2 ran
    });
  });

  // ---------------------------------------------------------------------------
  // parallel() tests
  // ---------------------------------------------------------------------------

  describe("parallel()", () => {
    it("executes all functions concurrently", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const startTimes: number[] = [];

      const results = await ctx.parallel("test-parallel", [
        async () => {
          startTimes.push(Date.now());
          await delay(20);
          return "a";
        },
        async () => {
          startTimes.push(Date.now());
          await delay(20);
          return "b";
        },
        async () => {
          startTimes.push(Date.now());
          await delay(20);
          return "c";
        },
      ]);

      expect(results).toEqual(["a", "b", "c"]);

      // All should start within 10ms of each other (concurrent)
      const spread = Math.max(...startTimes) - Math.min(...startTimes);
      expect(spread).toBeLessThan(15);
    });

    it("returns cached results on resume", async () => {
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      await ctx1.parallel("p1", [async () => "x", async () => "y"]);

      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let executed = false;
      const results = await ctx2.parallel("p1", [
        async () => {
          executed = true;
          return "new-x";
        },
        async () => "new-y",
      ]);

      expect(results).toEqual(["x", "y"]);
      expect(executed).toBe(false);
    });

    it("preserves result order regardless of completion order", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const results = await ctx.parallel("order-test", [
        async () => {
          await delay(30); // Slowest
          return "slow";
        },
        async () => {
          await delay(10); // Fastest
          return "fast";
        },
        async () => {
          await delay(20); // Medium
          return "medium";
        },
      ]);

      // Order by index, not completion time
      expect(results).toEqual(["slow", "fast", "medium"]);
    });
  });

  // ---------------------------------------------------------------------------
  // map() tests
  // ---------------------------------------------------------------------------

  describe("map()", () => {
    it("processes all items", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const results = await ctx.map("test-map", [1, 2, 3], async (item) => item * 2);

      expect(results).toEqual([2, 4, 6]);
    });

    it("respects maxConcurrency limit", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let concurrent = 0;
      let maxConcurrent = 0;

      const results = await ctx.map(
        "concurrency-test",
        [1, 2, 3, 4, 5],
        async (item) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await delay(20);
          concurrent--;
          return item * 2;
        },
        { maxConcurrency: 2 }
      );

      expect(results).toEqual([2, 4, 6, 8, 10]);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("returns cached results on resume", async () => {
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      await ctx1.map("m1", [1, 2, 3], async (item) => item * 10);

      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const executed: number[] = [];
      const results = await ctx2.map("m1", [1, 2, 3], async (item) => {
        executed.push(item);
        return item * 100;
      });

      expect(results).toEqual([10, 20, 30]); // Original results
      expect(executed).toEqual([]); // Nothing re-executed
    });

    it("resumes from partial progress", async () => {
      // First execution - process first 2 items, then "crash"
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let processed = 0;
      try {
        await ctx1.map(
          "crash-map",
          [1, 2, 3, 4],
          async (item) => {
            processed++;
            if (processed > 2) {
              throw new Error("Simulated crash");
            }
            return item * 10;
          },
          { maxConcurrency: 1 } // Process sequentially to control crash point
        );
      } catch {
        // Expected crash
      }

      // Resume - should only process remaining items
      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      const newProcessed: number[] = [];

      const results = await ctx2.map(
        "crash-map",
        [1, 2, 3, 4],
        async (item) => {
          newProcessed.push(item);
          return item * 10;
        },
        { maxConcurrency: 1 }
      );

      // Items 1 and 2 were cached, only 3 and 4 should be processed
      expect(newProcessed).toEqual([3, 4]);
      expect(results).toEqual([10, 20, 30, 40]);
    });
  });

  // ---------------------------------------------------------------------------
  // waitForCallback() tests
  // ---------------------------------------------------------------------------

  describe("waitForCallback()", () => {
    it("blocks until callback is resolved", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      // Start waiting in background
      const waitPromise = ctx.waitForCallback<{ approved: boolean }>("approval-123");

      // Simulate external resolution after short delay
      setTimeout(() => {
        resolveCallback(storage, "approval-123", { approved: true }, emitter);
      }, 50);

      const result = await waitPromise;
      expect(result).toEqual({ approved: true });
    });

    it("returns immediately if already resolved", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      // Pre-resolve callback
      storage.createCallback(ctx.executionId, "pre-resolved");
      storage.resolveCallback("pre-resolved", { data: "immediate" });

      const start = Date.now();
      const result = await ctx.waitForCallback<{ data: string }>("pre-resolved");
      const elapsed = Date.now() - start;

      expect(result).toEqual({ data: "immediate" });
      expect(elapsed).toBeLessThan(20); // Should be nearly instant
    });

    it("calls onWait handler when starting to wait", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      let onWaitCalled = false;

      const waitPromise = ctx.waitForCallback("wait-test", async () => {
        onWaitCalled = true;
      });

      // Resolve after checking onWait
      setTimeout(() => {
        expect(onWaitCalled).toBe(true);
        resolveCallback(storage, "wait-test", { done: true }, emitter);
      }, 50);

      await waitPromise;
    });

    it("updates execution status to waiting", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      // Don't await - we want to check status while waiting
      const waitPromise = ctx.waitForCallback("status-test");

      // Give it a moment to update status
      await delay(10);

      const execution = storage.getExecutionById(ctx.executionId);
      expect(execution?.status).toBe("waiting");
      expect(execution?.callbackId).toBe("status-test");

      // Cleanup
      resolveCallback(storage, "status-test", {}, emitter);
      await waitPromise;
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle tests
  // ---------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("marks execution as completed", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      await ctx.complete({ result: "success" });

      const execution = storage.getExecutionById(ctx.executionId);
      expect(execution?.status).toBe("completed");
      expect(execution?.completedAt).toBeTruthy();
    });

    it("marks execution as error", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      await ctx.markError(new Error("Something went wrong"));

      const execution = storage.getExecutionById(ctx.executionId);
      expect(execution?.status).toBe("error");
      expect(execution?.error).toBe("Something went wrong");
    });

    it("isResuming is false for new execution", async () => {
      const ctx = await createLocalDurableContext({
        storage,
        threadId: "new-thread",
        agentName: "new-agent",
        callbackEmitter: emitter,
      });

      expect(ctx.isResuming).toBe(false);
    });

    it("isResuming is true for resumed execution", async () => {
      // First execution
      const ctx1 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });
      await ctx1.step("s1", async () => "done");

      // Resume
      const ctx2 = await createLocalDurableContext({
        storage,
        threadId: "thread-1",
        agentName: "agent-1",
        callbackEmitter: emitter,
      });

      expect(ctx2.isResuming).toBe(true);
      expect(ctx2.lastCompletedStep).toBe("s1");
    });
  });
});

// =============================================================================
// Helper
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
