#!/usr/bin/env npx tsx
/**
 * Smoke Test for Reactive Agent Engine
 *
 * Tests the reactive driver with a real LLM (Haiku) and the HTTP mock MCP server.
 *
 * Usage:
 *   # Start the mock HTTP MCP server first (in another terminal):
 *   npx tsx packages/test-harness/src/mock-http-mcp-server.ts --port 4100
 *
 *   # Then run the smoke test:
 *   ANTHROPIC_API_KEY=... npx tsx packages/test-harness/src/smoke-test.ts
 *
 *   # Or set MCP_SERVER_URL to point to a different MCP server:
 *   MCP_SERVER_URL=http://localhost:5000 ANTHROPIC_API_KEY=... npx tsx packages/test-harness/src/smoke-test.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { defineAgent } from "@cikada/agent";
import {
  createReactiveDriver,
  AnthropicLLMAdapter,
  type MCPServerConfig,
} from "@cikada/local-runtime";

// =============================================================================
// Configuration
// =============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

// HTTP MCP server URL (default: local mock server)
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:4100";

// =============================================================================
// Agent Definition
// =============================================================================

const testAgent = defineAgent({
  name: "smoke-test-agent",
  system: `You are a test agent. When asked to test the echo tool, use the mcp__echo__echo tool to echo a message back.
Always use the tool when the user asks you to test it.`,
  config: {
    model: "claude-3-5-haiku-latest",
  },
});

// =============================================================================
// Smoke Test
// =============================================================================

async function runSmokeTest() {
  console.log("=".repeat(60));
  console.log("REACTIVE AGENT ENGINE SMOKE TEST");
  console.log("=".repeat(60));
  console.log();

  // Initialize components
  console.log("[1/3] Initializing Anthropic client...");
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const llmAdapter = new AnthropicLLMAdapter({ client: anthropic });

  console.log("[2/3] Configuring MCP server (HTTP)...");
  console.log(`     MCP Server URL: ${MCP_SERVER_URL}`);
  const mcpServers: MCPServerConfig[] = [
    {
      name: "echo",
      transport: "http",
      url: MCP_SERVER_URL,
    },
  ];

  console.log("[3/3] Creating reactive driver (stateless)...");
  const threadId = `smoke-test-${Date.now()}`;
  const driver = createReactiveDriver({
    llm: llmAdapter,
    mcpServers,
  });

  // Collect broadcast messages
  const messages: unknown[] = [];
  const broadcast = async (frame: string): Promise<void> => {
    try {
      const parsed = JSON.parse(frame);
      messages.push(parsed);

      // Log streaming progress
      if (parsed.a) {
        process.stdout.write(parsed.a);
      } else if (parsed.v?.type === "assistant") {
        console.log(`\n[Assistant]: ${parsed.v.content}`);
      } else if (parsed.v?.type === "tool_result") {
        console.log(`[Tool Result]: ${JSON.stringify(parsed.v.content)}`);
      }
    } catch {
      // Ignore parse errors
    }
  };

  console.log();
  console.log("-".repeat(60));
  console.log("Running agent with prompt: 'Test the echo tool with the message: Hello from smoke test!'");
  console.log("-".repeat(60));
  console.log();

  try {
    await driver.run({
      threadId,
      agentName: "smoke-test-agent",
      userMessage: "Test the echo tool with the message: Hello from smoke test!",
      agent: testAgent,
      broadcast,
    });

    console.log();
    console.log("-".repeat(60));
    console.log("SMOKE TEST RESULTS");
    console.log("-".repeat(60));

    // Verify results
    const toolResults = messages.filter((m: any) => m.v?.type === "tool_result");
    const assistantMessages = messages.filter((m: any) => m.v?.type === "assistant");

    console.log(`Total messages: ${messages.length}`);
    console.log(`Tool results: ${toolResults.length}`);
    console.log(`Assistant messages: ${assistantMessages.length}`);

    // Check if echo tool was called
    const echoResult = toolResults.find((m: any) => m.v?.toolName === "mcp__echo__echo");
    if (echoResult) {
      console.log();
      console.log("✅ Echo MCP tool was called successfully!");
      console.log(`   Tool name: ${(echoResult as any).v.toolName}`);
      console.log(`   Result: ${JSON.stringify((echoResult as any).v.content)}`);
    } else {
      console.log();
      console.log("❌ Echo MCP tool was NOT called");
      console.log("   Available tool results:", toolResults.map((m: any) => m.v?.toolName));
    }

    console.log();
    console.log("=".repeat(60));
    console.log("SMOKE TEST COMPLETE");
    console.log("=".repeat(60));

  } catch (error) {
    console.error();
    console.error("❌ SMOKE TEST FAILED");
    console.error(error);
    process.exit(1);
  }
}

// Run the test
runSmokeTest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
