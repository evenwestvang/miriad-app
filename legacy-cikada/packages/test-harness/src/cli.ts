#!/usr/bin/env node

/**
 * Test Harness CLI
 *
 * Usage:
 *   pnpm harness [options]
 *
 * Options:
 *   --port <number>     Port to listen on (default: 4000)
 *   --channel <string>  Channel name (default: test)
 *   --agent <string>    Agent ID (default: test-agent)
 */

import { createTestHarness } from "./server.js";

// Parse CLI arguments
const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return defaultValue;
}

const port = parseInt(getArg("port", "4000"), 10);
const channel = getArg("channel", "test");
const agentId = getArg("agent", "test-agent");

// Create and start harness
const harness = createTestHarness({
  port,
  channel,
  agentId,
});

console.log("Starting test harness...\n");

harness.start().then(() => {
  console.log("\nEndpoints:");
  console.log(`  GET  /health          - Health check`);
  console.log(`  POST /message         - Send message to agent`);
  console.log(`  GET  /messages        - Get message history`);
  console.log(`  GET  /artifacts       - List artifacts`);
  console.log(`  GET  /artifacts/:slug - Get specific artifact`);
  console.log(`  POST /artifacts       - Create artifact`);
  console.log(`  GET  /state           - Inspect agent state`);
  console.log(`  POST /reset           - Reset all stores`);
  console.log("\nExamples:");
  console.log(`  curl http://localhost:${port}/health`);
  console.log(`  curl -X POST http://localhost:${port}/message -H "Content-Type: application/json" -d '{"content": "Hello!", "sender": "user"}'`);
  console.log(`  curl http://localhost:${port}/messages`);
  console.log(`  curl http://localhost:${port}/artifacts`);
  console.log("\nPress Ctrl+C to stop.\n");
});

// Handle shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await harness.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await harness.stop();
  process.exit(0);
});
