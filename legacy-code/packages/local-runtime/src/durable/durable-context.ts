/**
 * Local Durable Context
 *
 * Provides durable execution primitives with SQLite-backed checkpointing.
 * Enables agents to survive process restarts by persisting execution state.
 *
 * Key features:
 * - step() - Execute once, return cached result on replay
 * - parallel() - Execute multiple functions concurrently with checkpointing
 * - map() - Process items with incremental progress tracking
 * - waitForCallback() - Block until external callback resolves
 */

import { EventEmitter } from "events";
import { DurableSqliteStorage, type Execution, type Checkpoint } from "./sqlite-storage.js";

// =============================================================================
// Types
// =============================================================================

export interface DurableContext {
  // Identity
  executionId: string;
  threadId: string;

  // Resume state
  isResuming: boolean;
  lastCompletedStep: string | null;

  // Core primitives
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForCallback<T>(callbackId: string, onWait?: () => Promise<void>): Promise<T>;

  // Parallel execution
  parallel<T extends readonly unknown[]>(
    name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T>;

  // Map iteration
  map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: { maxConcurrency?: number }
  ): Promise<R[]>;

  // Lifecycle
  complete(result?: unknown): Promise<void>;
  markError(error: Error): Promise<void>;
}

export interface CreateDurableContextOptions {
  storage: DurableSqliteStorage;
  threadId: string;
  agentName: string;
  callbackEmitter?: EventEmitter;
}

// =============================================================================
// Global Callback Emitter
// =============================================================================

/**
 * Global event emitter for callback resolution.
 * External code can resolve callbacks by emitting events on this emitter.
 */
export const callbackEmitter = new EventEmitter();
callbackEmitter.setMaxListeners(100); // Allow many concurrent waiters

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a durable context for an agent execution.
 * If a previous execution exists and is incomplete, resume from checkpoints.
 */
export async function createLocalDurableContext(
  options: CreateDurableContextOptions
): Promise<DurableContext> {
  const { storage, threadId, agentName, callbackEmitter: emitter = callbackEmitter } = options;

  // Check for existing execution
  const existing = storage.getExecution(threadId, agentName);

  if (existing && existing.status === "running") {
    // Resume from last checkpoint
    const checkpoints = storage.getCheckpoints(existing.id);
    const completedSteps = new Map<string, string>(
      checkpoints.map((c) => [c.stepName, c.resultJson ?? "null"])
    );

    const lastStep = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].stepName : null;

    console.log(
      `[DurableContext] Resuming execution ${existing.id} with ${checkpoints.length} checkpoints`
    );

    return new LocalDurableContext({
      storage,
      execution: existing,
      completedSteps,
      isResuming: true,
      lastCompletedStep: lastStep,
      callbackEmitter: emitter,
    });
  }

  // For completed or errored executions, delete the old one so we can create fresh
  if (existing && (existing.status === "completed" || existing.status === "error")) {
    console.log(`[DurableContext] Clearing previous ${existing.status} execution ${existing.id}`);
    storage.deleteExecution(existing.id);
  }

  if (existing && existing.status === "waiting") {
    // Check if callback was resolved
    const callback = existing.callbackId ? storage.getCallback(existing.callbackId) : null;

    if (callback?.resolvedAt) {
      // Resume with resolved callback
      const checkpoints = storage.getCheckpoints(existing.id);
      const completedSteps = new Map<string, string>(
        checkpoints.map((c) => [c.stepName, c.resultJson ?? "null"])
      );

      // Update execution to running
      storage.updateExecution(existing.id, { status: "running", callbackId: null });

      console.log(`[DurableContext] Resuming execution ${existing.id} with resolved callback`);

      return new LocalDurableContext({
        storage,
        execution: { ...existing, status: "running", callbackId: null },
        completedSteps,
        isResuming: true,
        lastCompletedStep: checkpoints[checkpoints.length - 1]?.stepName ?? null,
        callbackEmitter: emitter,
        resolvedCallbackPayload: callback.payloadJson ? JSON.parse(callback.payloadJson) : null,
      });
    }

    // Still waiting - return context that will continue waiting
    const checkpoints = storage.getCheckpoints(existing.id);
    const completedSteps = new Map<string, string>(
      checkpoints.map((c) => [c.stepName, c.resultJson ?? "null"])
    );

    console.log(`[DurableContext] Resuming waiting execution ${existing.id}`);

    return new LocalDurableContext({
      storage,
      execution: existing,
      completedSteps,
      isResuming: true,
      lastCompletedStep: checkpoints[checkpoints.length - 1]?.stepName ?? null,
      callbackEmitter: emitter,
    });
  }

  // Create new execution
  const execution = storage.createExecution(threadId, agentName);
  console.log(`[DurableContext] Created new execution ${execution.id}`);

  return new LocalDurableContext({
    storage,
    execution,
    completedSteps: new Map(),
    isResuming: false,
    lastCompletedStep: null,
    callbackEmitter: emitter,
  });
}

// =============================================================================
// Implementation
// =============================================================================

interface LocalDurableContextOptions {
  storage: DurableSqliteStorage;
  execution: Execution;
  completedSteps: Map<string, string>;
  isResuming: boolean;
  lastCompletedStep: string | null;
  callbackEmitter: EventEmitter;
  resolvedCallbackPayload?: unknown;
}

class LocalDurableContext implements DurableContext {
  private storage: DurableSqliteStorage;
  private execution: Execution;
  private completedSteps: Map<string, string>;
  private emitter: EventEmitter;
  private resolvedCallbackPayload?: unknown;

  readonly executionId: string;
  readonly threadId: string;
  readonly isResuming: boolean;
  readonly lastCompletedStep: string | null;

  constructor(options: LocalDurableContextOptions) {
    this.storage = options.storage;
    this.execution = options.execution;
    this.completedSteps = options.completedSteps;
    this.isResuming = options.isResuming;
    this.lastCompletedStep = options.lastCompletedStep;
    this.emitter = options.callbackEmitter;
    this.resolvedCallbackPayload = options.resolvedCallbackPayload;

    this.executionId = options.execution.id;
    this.threadId = options.execution.threadId;
  }

  // ---------------------------------------------------------------------------
  // step()
  // ---------------------------------------------------------------------------

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // Check cache first (for resumed executions)
    if (this.completedSteps.has(name)) {
      console.log(`[DurableContext] Skipping step "${name}" (cached)`);
      return JSON.parse(this.completedSteps.get(name)!) as T;
    }

    // Execute and checkpoint
    console.log(`[DurableContext] Executing step "${name}"`);
    const result = await fn();

    this.storage.saveCheckpoint(this.executionId, name, "step", result);
    this.completedSteps.set(name, JSON.stringify(result));

    return result;
  }

  // ---------------------------------------------------------------------------
  // parallel()
  // ---------------------------------------------------------------------------

  async parallel<T extends readonly unknown[]>(
    name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    // Check if already completed
    if (this.completedSteps.has(name)) {
      console.log(`[DurableContext] Skipping parallel "${name}" (cached)`);
      return JSON.parse(this.completedSteps.get(name)!) as T;
    }

    // Execute all in parallel
    console.log(`[DurableContext] Executing parallel "${name}" with ${fns.length} tasks`);
    const results = await Promise.all(fns.map((fn) => fn()));

    // Checkpoint the combined result
    this.storage.saveCheckpoint(this.executionId, name, "parallel", results);
    this.completedSteps.set(name, JSON.stringify(results));

    return results as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // map()
  // ---------------------------------------------------------------------------

  async map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: { maxConcurrency?: number }
  ): Promise<R[]> {
    // Check if fully completed
    if (this.completedSteps.has(name)) {
      console.log(`[DurableContext] Skipping map "${name}" (cached)`);
      return JSON.parse(this.completedSteps.get(name)!) as R[];
    }

    // Get partial progress
    const progress = this.storage.getMapProgress(this.executionId, name);
    const completedIndices = new Set(progress.map((p) => p.itemIndex));
    const results: R[] = new Array(items.length);

    // Fill in completed results
    for (const p of progress) {
      results[p.itemIndex] = JSON.parse(p.resultJson ?? "null") as R;
    }

    // Get remaining items
    const remaining = items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => !completedIndices.has(index));

    if (remaining.length > 0) {
      console.log(
        `[DurableContext] Executing map "${name}" with ${remaining.length} remaining items`
      );
    }

    const concurrency = opts?.maxConcurrency ?? Infinity;

    // Process in batches respecting concurrency
    for (let i = 0; i < remaining.length; i += concurrency) {
      const batch = remaining.slice(i, Math.min(i + concurrency, remaining.length));
      const batchResults = await Promise.all(
        batch.map(async ({ item, index }) => {
          const result = await fn(item, index);

          // Checkpoint each item
          this.storage.saveMapProgress(this.executionId, name, index, result);

          return { index, result };
        })
      );

      for (const { index, result } of batchResults) {
        results[index] = result;
      }
    }

    // Mark map as fully completed
    this.storage.saveCheckpoint(this.executionId, name, "map", results);
    this.completedSteps.set(name, JSON.stringify(results));

    return results;
  }

  // ---------------------------------------------------------------------------
  // waitForCallback()
  // ---------------------------------------------------------------------------

  async waitForCallback<T>(callbackId: string, onWait?: () => Promise<void>): Promise<T> {
    // Check if we have a pre-resolved callback from resume
    if (this.resolvedCallbackPayload !== undefined) {
      const payload = this.resolvedCallbackPayload;
      this.resolvedCallbackPayload = undefined;
      console.log(`[DurableContext] Returning pre-resolved callback "${callbackId}"`);
      return payload as T;
    }

    // Check if callback already resolved
    const existing = this.storage.getCallback(callbackId);
    if (existing?.resolvedAt) {
      console.log(`[DurableContext] Callback "${callbackId}" already resolved`);
      return JSON.parse(existing.payloadJson ?? "null") as T;
    }

    // Create callback record if not exists
    if (!existing) {
      this.storage.createCallback(this.executionId, callbackId);
    }

    // Update execution to waiting state
    this.storage.updateExecution(this.executionId, {
      status: "waiting",
      callbackId,
    });

    // Call onWait handler if provided
    if (onWait) {
      await onWait();
    }

    console.log(`[DurableContext] Waiting for callback "${callbackId}"`);

    // Wait for callback resolution via event emitter
    // IMPORTANT: Register listener BEFORE checking DB to avoid TOCTOU race condition.
    // If we check first, the callback could be resolved between our check and registration,
    // causing the event to be missed and the Promise to hang forever.
    return new Promise<T>((resolve) => {
      let resolved = false;

      const handler = (payload: unknown) => {
        if (resolved) return; // Already resolved via DB check
        resolved = true;

        console.log(`[DurableContext] Callback "${callbackId}" resolved via event`);

        // Update execution back to running
        this.storage.updateExecution(this.executionId, {
          status: "running",
          callbackId: null,
        });

        resolve(payload as T);
      };

      // Register listener FIRST (before DB check)
      this.emitter.once(callbackId, handler);

      // THEN check if already resolved in DB
      const callback = this.storage.getCallback(callbackId);
      if (callback?.resolvedAt) {
        if (resolved) return; // Event fired while we were checking DB
        resolved = true;

        // Clean up listener since we're resolving from DB
        this.emitter.removeListener(callbackId, handler);

        console.log(`[DurableContext] Callback "${callbackId}" already resolved in DB`);
        resolve(JSON.parse(callback.payloadJson ?? "null") as T);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async complete(result?: unknown): Promise<void> {
    console.log(`[DurableContext] Execution ${this.executionId} completed`);
    this.storage.updateExecution(this.executionId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    // Save completion as a checkpoint
    this.storage.saveCheckpoint(this.executionId, "__complete__", "step", result);
  }

  async markError(error: Error): Promise<void> {
    console.log(`[DurableContext] Execution ${this.executionId} errored: ${error.message}`);
    this.storage.updateExecution(this.executionId, {
      status: "error",
      error: error.message,
    });
  }
}

// =============================================================================
// Helper: Resolve Callback
// =============================================================================

/**
 * Resolve a callback externally (e.g., from API endpoint).
 * This will persist the payload and emit an event to wake up any waiting context.
 */
export function resolveCallback(
  storage: DurableSqliteStorage,
  callbackId: string,
  payload: unknown,
  emitter: EventEmitter = callbackEmitter
): void {
  storage.resolveCallback(callbackId, payload);

  // Get the execution waiting on this callback
  const callback = storage.getCallback(callbackId);
  if (callback) {
    // Update execution status
    storage.updateExecution(callback.executionId, {
      status: "running",
      callbackId: null,
    });
  }

  // Emit event to wake up waiting context
  emitter.emit(callbackId, payload);
}
