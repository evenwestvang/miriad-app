#!/usr/bin/env npx ts-node
/**
 * Minimal Custom Agent Backend - Spike Test
 *
 * Tests the three-phase handshake:
 * 1. Agent sends agent/ready notification
 * 2. PowPow sends agent/initialize request
 * 3. Agent responds with {ok: true}
 */

import * as readline from 'readline';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(msg: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', result, id });
}

async function main(): Promise<void> {
  // Phase 1: Announce readiness immediately on spawn
  notify('agent/ready', {
    protocolVersion: '1.0',
    engineName: 'spike-agent',
    engineVersion: '0.1.0',
    capabilities: {
      supportsMidTurnMessages: false,
      supportsInterruption: true,
      exposesReasoning: false,
      supportsSessionResume: false
    }
  });

  console.error('[spike-agent] Sent agent/ready, waiting for initialize...');

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error(`[spike-agent] Parse error: ${e}`);
      continue;
    }

    console.error(`[spike-agent] Received: ${msg.method || 'response'}`);

    switch (msg.method) {
      case 'agent/initialize':
        const config = (msg.params?.config as Record<string, unknown>) || {};
        console.error(`[spike-agent] Initialized with workDir: ${config.workDir}`);
        respond(msg.id!, { ok: true });
        break;

      case 'agent/execute':
        const task = (msg.params?.task as string) || 'no task';
        console.error(`[spike-agent] Executing: ${task}`);

        // Simulate streaming output
        notify('agent/output', { type: 'text', content: `Echo: ${task}\n` });
        notify('agent/progress', { status: 'idle' });

        respond(msg.id!, { status: 'complete' });
        break;

      case 'agent/shutdown':
        console.error('[spike-agent] Shutting down');
        respond(msg.id!, { ok: true });
        process.exit(0);
        break;

      default:
        send({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown method: ${msg.method}` },
          id: msg.id!
        });
    }
  }
}

main().catch(e => {
  console.error(`[spike-agent] Fatal: ${e}`);
  process.exit(1);
});
