/**
 * @cikada/test-harness
 *
 * Standalone test harness for validating reactive agents without the full
 * Cikada server stack.
 *
 * @example
 * ```typescript
 * import { createTestHarness, createAgentRunner } from "@cikada/test-harness";
 * import { defineAgent } from "@cikada/agent";
 * import { MockLLMAdapter, mockTextResponse } from "@cikada/local-runtime";
 *
 * const harness = createTestHarness({ port: 4000 });
 * await harness.start();
 *
 * // Create an agent runner
 * const runner = createAgentRunner({
 *   messageStore: harness.messages,
 *   artifactStore: harness.artifacts,
 *   channel: "test",
 *   agentName: "test-agent",
 * });
 *
 * // Queue a mock response
 * runner.queueResponse("Hello! I'm the test agent.");
 *
 * // Run an agent
 * const agent = defineAgent({ system: "You are a helpful assistant." });
 * const result = await runner.run({ agent, userMessage: "Hello!" });
 * ```
 */

export { TestHarnessServer, createTestHarness, type HarnessConfig } from "./server.js";

export {
  MessageStore,
  ArtifactStore,
  AgentStateStore,
  type Message,
  type Artifact,
  type AgentState,
} from "./stores.js";

export {
  AgentRunner,
  createAgentRunner,
  type AgentRunnerOptions,
  type RunAgentOptions,
} from "./agent-runner.js";
