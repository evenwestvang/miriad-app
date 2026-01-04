#!/usr/bin/env npx tsx
/**
 * Echo Agent - Reference Implementation
 *
 * Minimal agent that implements the PowPow custom backend protocol.
 * Echoes back any message it receives, useful for testing integration.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (NDJSON framing)
 *
 * Flow:
 * 1. Agent sends agent/ready notification on startup
 * 2. PowPow sends agent/initialize request
 * 3. Agent responds with {ok: true}
 * 4. PowPow sends agent/execute with user messages
 * 5. Agent echoes back via agent/output notifications
 *
 * Supports --capabilities flag for capability discovery (required protocol).
 */

import * as readline from "readline";

// Capability manifest for this agent
const CAPABILITIES_MANIFEST = {
  engineName: "echo-agent",
  engineVersion: "1.0.0",
  capabilities: {
    supportsMcp: false,        // This simple agent doesn't support MCP servers
    supportsTools: false,      // No tool use support
    supportsVision: false,     // No vision/image support
    supportsMidTurnMessages: false,
    supportsInterruption: true,
    exposesReasoning: false,
    supportsSessionResume: false,
  },
};

// Handle --capabilities flag: output manifest and exit
if (process.argv.includes("--capabilities")) {
  console.log(JSON.stringify(CAPABILITIES_MANIFEST));
  process.exit(0);
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(msg: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", result, id });
}

async function main(): Promise<void> {
  // Phase 1: Announce readiness (same capabilities as --capabilities manifest)
  notify("agent/ready", {
    protocolVersion: "1.0",
    ...CAPABILITIES_MANIFEST,
  });

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    switch (msg.method) {
      case "agent/initialize":
        // Phase 2-3: Acknowledge initialization
        respond(msg.id!, { ok: true });
        break;

      case "agent/execute":
        // Echo back the task/message
        const task = (msg.params?.task as string) || "";
        notify("agent/output", { type: "text", content: `Echo: ${task}\n` });
        notify("agent/progress", { status: "idle" });
        respond(msg.id!, { status: "complete" });
        break;

      case "agent/shutdown":
        respond(msg.id!, { ok: true });
        process.exit(0);
        break;

      default:
        if (msg.id) {
          send({
            jsonrpc: "2.0",
            error: { code: -32601, message: `Unknown method: ${msg.method}` },
            id: msg.id,
          });
        }
    }
  }
}

main().catch(() => process.exit(1));
