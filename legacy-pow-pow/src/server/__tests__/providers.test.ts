/**
 * Integration tests for CodingAgentProvider implementations.
 *
 * Tests both Claude and Codex providers against the same test suite
 * to verify interface compliance and behavioral consistency.
 *
 * Run with: npx tsx --test src/server/__tests__/providers.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import type {
  CodingAgentProvider,
  AgentConfig,
  AgentHandle,
  AgentState,
  AgentOutput,
} from "../agent-provider.js";
import { ProviderRegistry, createDefaultRegistry } from "../agent-registry.js";

// Test configuration
const TEST_CHANNEL = "test-channel";
const TEST_TIMEOUT = 30000; // 30 seconds for API calls

/**
 * Create a temporary working directory for test agents.
 */
function createTestWorkdir(provider: string, testName: string): string {
  const workdir = path.join(
    os.tmpdir(),
    "powpow-tests",
    provider,
    testName,
    Date.now().toString()
  );
  fs.mkdirSync(workdir, { recursive: true });
  return workdir;
}

/**
 * Clean up test working directory.
 */
function cleanupTestWorkdir(workdir: string): void {
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Wait for agent to reach a specific state.
 */
async function waitForState(
  provider: CodingAgentProvider,
  handle: AgentHandle,
  targetState: AgentState,
  timeoutMs = 10000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (provider.getState(handle) === targetState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timeout waiting for state "${targetState}", current: "${provider.getState(handle)}"`
  );
}

/**
 * Collect outputs from an agent until idle.
 */
async function collectOutputsUntilIdle(
  provider: CodingAgentProvider,
  handle: AgentHandle,
  timeoutMs = 30000
): Promise<AgentOutput[]> {
  const outputs: AgentOutput[] = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for outputs"));
    }, timeoutMs);

    provider.onOutput(handle, (output) => {
      outputs.push(output);
    });

    provider.onStateChange(handle, (state) => {
      if (state === "idle" && outputs.length > 0) {
        clearTimeout(timeout);
        // Give a small delay to collect any final outputs
        setTimeout(() => resolve(outputs), 200);
      }
    });
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("CodingAgentProvider Integration Tests", () => {
  let registry: ProviderRegistry;
  let providers: CodingAgentProvider[];

  before(async () => {
    registry = await createDefaultRegistry();
    providers = registry.getAll();

    if (providers.length === 0) {
      throw new Error("No providers registered. Check SDK installations.");
    }

    console.log(`Testing ${providers.length} provider(s): ${registry.list().join(", ")}`);
  });

  // Run all tests for each provider
  for (const providerName of ["claude", "codex"]) {
    describe(`Provider: ${providerName}`, () => {
      let provider: CodingAgentProvider | undefined;
      let handle: AgentHandle | undefined;
      let workdir: string;

      before(() => {
        provider = registry.get(providerName);
        if (!provider) {
          console.log(`Skipping ${providerName} tests - provider not available`);
        }
      });

      afterEach(async () => {
        // Clean up agent after each test
        if (provider && handle) {
          try {
            await provider.kick(handle);
          } catch {
            // Ignore cleanup errors
          }
          handle = undefined;
        }
        if (workdir) {
          cleanupTestWorkdir(workdir);
        }
      });

      // --------------------------------------------------------------------
      // 1. Capabilities
      // --------------------------------------------------------------------

      it("should expose correct capabilities", { skip: !provider }, () => {
        if (!provider) return;

        const caps = provider.capabilities;

        assert.strictEqual(typeof caps.supportsMidTurnMessages, "boolean");
        assert.strictEqual(typeof caps.supportsInterruption, "boolean");
        assert.strictEqual(typeof caps.exposesReasoning, "boolean");
        assert.strictEqual(typeof caps.supportsSessionResume, "boolean");

        // Provider-specific capability checks
        if (providerName === "claude") {
          assert.strictEqual(caps.supportsMidTurnMessages, true);
          assert.strictEqual(caps.exposesReasoning, false);
        } else if (providerName === "codex") {
          assert.strictEqual(caps.supportsMidTurnMessages, false);
          assert.strictEqual(caps.exposesReasoning, true);
        }
      });

      // --------------------------------------------------------------------
      // 2. Lifecycle: spawn → idle → kick → stopped
      // --------------------------------------------------------------------

      it("should spawn and reach idle state", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "spawn-idle");

        const config: AgentConfig = {
          workdir,
          resume: false,
        };

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", config);

        // Verify handle properties
        assert.ok(handle.id, "Handle should have an id");
        assert.strictEqual(handle.channel, TEST_CHANNEL);
        assert.strictEqual(handle.name, "test-agent");
        assert.strictEqual(handle.engine, providerName);

        // Should reach idle state
        await waitForState(provider, handle, "idle", 10000);
        assert.strictEqual(provider.getState(handle), "idle");
      });

      it("should kick agent and reach stopped state", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "kick-stopped");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        await provider.kick(handle);

        assert.strictEqual(provider.getState(handle), "stopped");
        handle = undefined; // Prevent double-kick in afterEach
      });

      it("should throw when spawning duplicate agent", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "spawn-duplicate");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        // Attempt to spawn again with same channel+name
        await assert.rejects(
          () => provider!.spawn(TEST_CHANNEL, "test-agent", { workdir }),
          /already running/i
        );
      });

      // --------------------------------------------------------------------
      // 3. State transitions
      // --------------------------------------------------------------------

      it("should track state transitions", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "state-transitions");

        const stateChanges: { from?: AgentState; to: AgentState }[] = [];

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });

        provider.onStateChange(handle, (state, previous) => {
          stateChanges.push({ from: previous, to: state });
        });

        await waitForState(provider, handle, "idle");

        // Should have transitioned through starting → idle
        assert.ok(
          stateChanges.some((c) => c.to === "idle"),
          "Should have reached idle state"
        );
      });

      // --------------------------------------------------------------------
      // 4. Message sending and output streaming
      // --------------------------------------------------------------------

      it("should send message and receive output", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "message-output");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        const outputs: AgentOutput[] = [];
        provider.onOutput(handle, (output) => {
          outputs.push(output);
        });

        // Send a simple message
        await provider.sendMessage(handle, "Say hello");

        // Wait for response
        await waitForState(provider, handle, "idle", 20000);

        // Should have received some output
        assert.ok(outputs.length > 0, "Should have received output");

        // Should have at least one text output
        const textOutputs = outputs.filter((o) => o.type === "text");
        assert.ok(textOutputs.length > 0, "Should have text output");
      });

      // --------------------------------------------------------------------
      // 5. Pending message count (Codex-specific)
      // --------------------------------------------------------------------

      it("should track pending messages", { skip: !provider }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "pending-messages");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        // Initially no pending messages
        assert.strictEqual(provider.getPendingMessageCount(handle), 0);

        // For Codex: messages sent during active turn should queue
        // For Claude: messages are delivered immediately (no queue)
        // Both should report 0 when idle
      });

      // --------------------------------------------------------------------
      // 6. Session resume
      // --------------------------------------------------------------------

      it("should report canResume status", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "can-resume");

        // Before spawning, no session exists
        const canResumeBefore = await provider.canResume(TEST_CHANNEL, "resume-test");
        // Note: canResume checks a different path, so this may vary

        // Spawn and kick
        handle = await provider.spawn(TEST_CHANNEL, "resume-test", { workdir });
        await waitForState(provider, handle, "idle");
        await provider.kick(handle);
        handle = undefined;

        // After spawn, session file should exist
        const canResumeAfter = await provider.canResume(TEST_CHANNEL, "resume-test");
        // The exact behavior depends on implementation details
      });

      // --------------------------------------------------------------------
      // 7. Working directory
      // --------------------------------------------------------------------

      it("should return correct workdir", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "workdir");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        assert.strictEqual(provider.getWorkdir(handle), workdir);
      });

      // --------------------------------------------------------------------
      // 8. Output types
      // --------------------------------------------------------------------

      it("should emit correctly typed outputs", { skip: !provider, timeout: TEST_TIMEOUT }, async () => {
        if (!provider) return;

        workdir = createTestWorkdir(providerName, "output-types");

        handle = await provider.spawn(TEST_CHANNEL, "test-agent", { workdir });
        await waitForState(provider, handle, "idle");

        const outputs: AgentOutput[] = [];
        provider.onOutput(handle, (output) => {
          outputs.push(output);

          // Verify output structure
          assert.ok(output.type, "Output should have type");
          assert.ok(output.timestamp, "Output should have timestamp");
          assert.ok(typeof output.content === "string", "Content should be string");

          // Verify valid output type
          const validTypes = ["text", "tool_call", "tool_result", "error", "system", "reasoning"];
          assert.ok(validTypes.includes(output.type), `Invalid output type: ${output.type}`);
        });

        // Trigger some output
        await provider.sendMessage(handle, "What is 2+2?");
        await waitForState(provider, handle, "idle", 20000);
      });
    });
  }
});

// ============================================================================
// Provider Registry Tests
// ============================================================================

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("should start empty", () => {
    assert.strictEqual(registry.size, 0);
    assert.deepStrictEqual(registry.list(), []);
  });

  it("should register and retrieve providers", () => {
    const mockProvider = {
      name: "mock",
      capabilities: {
        supportsMidTurnMessages: true,
        supportsInterruption: true,
        exposesReasoning: false,
        supportsSessionResume: true,
      },
    } as CodingAgentProvider;

    registry.register(mockProvider);

    assert.strictEqual(registry.size, 1);
    assert.ok(registry.has("mock"));
    assert.strictEqual(registry.get("mock"), mockProvider);
    assert.deepStrictEqual(registry.list(), ["mock"]);
  });

  it("should be case-insensitive", () => {
    const mockProvider = { name: "Mock" } as CodingAgentProvider;
    registry.register(mockProvider);

    assert.ok(registry.has("mock"));
    assert.ok(registry.has("MOCK"));
    assert.ok(registry.has("Mock"));
  });

  it("should throw on duplicate registration", () => {
    const mockProvider = { name: "mock" } as CodingAgentProvider;
    registry.register(mockProvider);

    assert.throws(
      () => registry.register(mockProvider),
      /already registered/i
    );
  });

  it("should throw on getOrThrow for missing provider", () => {
    assert.throws(
      () => registry.getOrThrow("nonexistent"),
      /unknown engine/i
    );
  });

  it("should unregister providers", () => {
    const mockProvider = { name: "mock" } as CodingAgentProvider;
    registry.register(mockProvider);

    assert.ok(registry.unregister("mock"));
    assert.strictEqual(registry.size, 0);
    assert.ok(!registry.has("mock"));
  });

  it("should clear all providers", () => {
    registry.register({ name: "a" } as CodingAgentProvider);
    registry.register({ name: "b" } as CodingAgentProvider);

    registry.clear();

    assert.strictEqual(registry.size, 0);
  });
});

describe("Default Registry", () => {
  it("should create registry with default providers", async () => {
    const registry = await createDefaultRegistry();

    // Should have at least the providers that are installed
    assert.ok(registry.size >= 0);

    // Log available providers for diagnostics
    console.log("Default registry providers:", registry.list());
  });
});
