#!/usr/bin/env npx ts-node
/**
 * Echo Agent - Minimal External Backend Implementation
 *
 * A simple reference implementation that echoes back any input.
 * Use this to verify the ExternalProvider integration works correctly.
 *
 * Protocol: JSON-RPC 2.0 over NDJSON (newline-delimited JSON on stdin/stdout)
 *
 * Handshake sequence:
 *   1. Agent sends `agent/ready` notification on startup
 *   2. PowPow sends `agent/initialize` request
 *   3. Agent responds with `{ ok: true }`
 *
 * Message handling:
 *   - `agent/execute` request → echoes task back via `agent/output` notification
 *   - `agent/shutdown` request → clean exit
 *   - `agent/cancel` notification → interrupt current work (no-op for echo)
 *
 * Usage:
 *   npx ts-node examples/echo-agent.ts
 *
 * In backends.yaml:
 *   - name: echo-agent
 *     path: npx
 *     args: [ts-node, examples/echo-agent.ts]
 */

import * as readline from "readline";

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string;
}

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;

// ============================================================================
// Protocol Helpers
// ============================================================================

function send(msg: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", result, id });
}

function respondError(
  id: number | string,
  code: number,
  message: string
): void {
  send({ jsonrpc: "2.0", error: { code, message }, id });
}

function log(msg: string): void {
  // Log to stderr so it doesn't interfere with NDJSON on stdout
  console.error(`[echo-agent] ${msg}`);
}

// ============================================================================
// Agent State
// ============================================================================

let isRunning = true;
let workDir = "/tmp";

// ============================================================================
// Message Handlers
// ============================================================================

function handleInitialize(
  id: number | string,
  params: Record<string, unknown>
): void {
  const config = (params.config as Record<string, unknown>) || {};
  workDir = (config.workDir as string) || "/tmp";

  log(`Initialized with workDir: ${workDir}`);
  respond(id, { ok: true });
}

function handleExecute(
  id: number | string,
  params: Record<string, unknown>
): void {
  const task = (params.task as string) || "";

  log(`Executing task: ${task.substring(0, 50)}${task.length > 50 ? "..." : ""}`);

  // Signal we're working
  notify("agent/progress", { status: "thinking" });

  // Echo the input back
  const response = `Echo: ${task}`;

  // Send the output
  notify("agent/output", {
    type: "text",
    content: response,
  });

  // Signal we're done
  notify("agent/progress", { status: "idle" });

  // Complete the request
  respond(id, { status: "complete" });
}

function handleShutdown(id: number | string): void {
  log("Shutdown requested");
  respond(id, { ok: true });
  isRunning = false;
}

function handleCancel(): void {
  // For echo agent, there's nothing to cancel
  log("Cancel received (no-op for echo agent)");
}

function handleMessage(msg: JsonRpcMessage): void {
  // Handle requests (have `id` and `method`)
  if ("id" in msg && "method" in msg && msg.method) {
    const request = msg as JsonRpcRequest;

    switch (request.method) {
      case "agent/initialize":
        handleInitialize(request.id, request.params || {});
        break;

      case "agent/execute":
        handleExecute(request.id, request.params || {});
        break;

      case "agent/shutdown":
        handleShutdown(request.id);
        break;

      default:
        respondError(request.id, -32601, `Unknown method: ${request.method}`);
    }
    return;
  }

  // Handle notifications (have `method` but no `id`)
  if ("method" in msg && msg.method && !("id" in msg)) {
    const notification = msg as JsonRpcNotification;

    switch (notification.method) {
      case "agent/cancel":
        handleCancel();
        break;

      default:
        log(`Unknown notification: ${notification.method}`);
    }
    return;
  }

  // Ignore responses (have `id` but no `method`) - we don't send requests
  log(`Ignoring message: ${JSON.stringify(msg)}`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log("Starting echo agent...");

  // Phase 1: Announce readiness immediately
  notify("agent/ready", {
    protocolVersion: "1.0",
    engineName: "echo-agent",
    engineVersion: "1.0.0",
    capabilities: {
      supportsMidTurnMessages: false,
      supportsInterruption: true,
      exposesReasoning: false,
      supportsSessionResume: false,
    },
  });

  log("Sent agent/ready, waiting for initialize...");

  // Set up stdin reader
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Process messages
  for await (const line of rl) {
    if (!line.trim()) continue;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`Parse error: ${e}`);
      continue;
    }

    handleMessage(msg);

    if (!isRunning) {
      break;
    }
  }

  log("Exiting");
  process.exit(0);
}

main().catch((e) => {
  console.error(`[echo-agent] Fatal error: ${e}`);
  process.exit(1);
});
