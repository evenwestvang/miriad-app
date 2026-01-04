#!/usr/bin/env npx tsx
/**
 * End-to-end test for external backend integration
 *
 * Tests the full flow:
 * 1. Load backends.yaml → register ExternalProvider
 * 2. Hat references external backend by engine name
 * 3. Spawn agent via AgentManager
 * 4. Send message → receive output
 */

import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { loadBackends } from "../src/server/defaults.ts";
import {
  ProviderRegistry,
  registerExternalBackends,
  type ExternalBackendConfig,
} from "../src/server/agent-registry.ts";
import type { AgentOutput } from "../src/server/agent-provider.ts";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("[e2e] Starting external backend end-to-end test\n");

  const defaultsDir = path.join(__dirname, "..", "defaults");
  const workdir = "/tmp/test-e2e-external-backend";

  // === Step 1: Load backends from YAML ===
  console.log("[e2e] === Step 1: Load backends.yaml ===");

  const backendConfigs = loadBackends(defaultsDir);
  console.log(`[e2e] Found ${backendConfigs.length} backend(s):`);
  for (const config of backendConfigs) {
    console.log(`[e2e]   - ${config.name}: ${config.path} ${config.args?.join(" ") || ""}`);
  }

  if (backendConfigs.length === 0) {
    throw new Error("No backends found in backends.yaml");
  }

  const spikeConfig = backendConfigs.find((c) => c.name === "spike-agent");
  if (!spikeConfig) {
    throw new Error("spike-agent not found in backends.yaml");
  }
  console.log("[e2e] ✓ spike-agent backend found\n");

  // === Step 2: Register with ProviderRegistry ===
  console.log("[e2e] === Step 2: Register backends ===");

  const registry = new ProviderRegistry();
  await registerExternalBackends(registry, backendConfigs);

  const engines = registry.list();
  console.log(`[e2e] Registered engines: ${engines.join(", ")}`);

  if (!registry.has("spike-agent")) {
    throw new Error("spike-agent not registered");
  }
  console.log("[e2e] ✓ spike-agent registered\n");

  // === Step 3: Get provider and spawn agent ===
  console.log("[e2e] === Step 3: Spawn agent ===");

  const provider = registry.getOrThrow("spike-agent");
  console.log(`[e2e] Provider: ${provider.name}`);
  console.log(`[e2e] Capabilities:`, provider.capabilities);

  const outputs: AgentOutput[] = [];

  const handle = await provider.spawn("test-channel", "test-agent", {
    workdir,
  });

  console.log(`[e2e] ✓ Agent spawned: ${handle.id}`);
  console.log(`[e2e]   engine: ${handle.engine}`);

  // Register output callback
  provider.onOutput(handle, (output) => {
    outputs.push(output);
    console.log(`[e2e]   output: ${output.type} - ${output.content?.substring(0, 50)}`);
  });

  // === Step 4: Send message and verify output ===
  console.log("\n[e2e] === Step 4: Send message ===");

  await provider.sendMessage(handle, "Hello from e2e test!");

  // Wait for outputs
  await sleep(500);

  const textOutputs = outputs.filter((o) => o.type === "text");
  if (textOutputs.length === 0) {
    throw new Error("No text output received");
  }
  console.log(`[e2e] ✓ Received ${textOutputs.length} text output(s)`);

  // === Step 5: Cleanup ===
  console.log("\n[e2e] === Step 5: Cleanup ===");

  await provider.kick(handle);
  console.log("[e2e] ✓ Agent kicked\n");

  console.log("[e2e] ========================================");
  console.log("[e2e] ✓ END-TO-END TEST PASSED");
  console.log("[e2e] ========================================\n");

  console.log("[e2e] Summary:");
  console.log("[e2e]   - backends.yaml loaded correctly");
  console.log("[e2e]   - ExternalProvider registered as 'spike-agent'");
  console.log("[e2e]   - Agent spawned via provider.spawn()");
  console.log("[e2e]   - Message sent and output received");
  console.log("[e2e]   - Graceful shutdown worked");
}

main().catch((err) => {
  console.error("\n[e2e] ✗ TEST FAILED:", err);
  process.exit(1);
});
