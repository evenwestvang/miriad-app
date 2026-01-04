#!/usr/bin/env npx ts-node
/**
 * Subprocess Handshake Spike - PowPow Side
 *
 * Validates the three-phase handshake:
 * 1. Wait for agent/ready from binary
 * 2. Send agent/initialize
 * 3. Wait for ack response
 *
 * Then sends a test execute and shutdown.
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

class SubprocessHandshakeTest {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests = new Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 1;
  private readyReceived = false;
  private capabilities: Record<string, unknown> = {};

  async spawn(binaryPath: string): Promise<void> {
    console.log(`[test] Spawning: ${binaryPath}`);

    this.process = spawn('npx', ['ts-node', binaryPath], {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout piped; stderr inherited
    });

    this.rl = readline.createInterface({
      input: this.process.stdout!,
    });

    // Handle incoming messages
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg: JsonRpcMessage = JSON.parse(line);
        this.handleMessage(msg);
      } catch (e) {
        console.error(`[test] Parse error: ${e}`);
      }
    });

    this.process.on('exit', (code) => {
      console.log(`[test] Process exited with code: ${code}`);
    });

    // Wait for agent/ready
    await this.waitForReady(5000);
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for agent/ready'));
      }, timeoutMs);

      const check = () => {
        if (this.readyReceived) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Is it a notification?
    if (msg.method && msg.id === undefined) {
      console.log(`[test] Notification: ${msg.method}`, msg.params);

      if (msg.method === 'agent/ready') {
        this.readyReceived = true;
        this.capabilities = (msg.params?.capabilities as Record<string, unknown>) || {};
        console.log('[test] ✓ Received agent/ready');
        console.log('[test]   capabilities:', this.capabilities);
      }
      return;
    }

    // Is it a response?
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin) {
      throw new Error('Process not spawned');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', method, params, id });
    });
  }

  async initialize(): Promise<void> {
    console.log('[test] Sending agent/initialize...');
    const result = await this.request('agent/initialize', {
      config: {
        workDir: '/tmp/spike-test',
        sessionId: 'test-session-1',
        tools: ['bash', 'read', 'write'],
        model: 'custom'
      },
      credentials: {
        apiKey: 'sk-test-123'
      },
      mcpServers: {
        powpow: {
          type: 'sse',
          url: 'http://localhost:3131/mcp/sse'
        }
      }
    });
    console.log('[test] ✓ Initialize response:', result);
  }

  async execute(task: string): Promise<void> {
    console.log(`[test] Sending agent/execute: "${task}"`);
    const result = await this.request('agent/execute', { task });
    console.log('[test] ✓ Execute response:', result);
  }

  async shutdown(): Promise<void> {
    console.log('[test] Sending agent/shutdown...');
    const result = await this.request('agent/shutdown', {});
    console.log('[test] ✓ Shutdown response:', result);
  }
}

async function main() {
  const test = new SubprocessHandshakeTest();
  const agentPath = path.join(__dirname, 'example-agent.ts');

  try {
    // Phase 1: Spawn and wait for ready
    await test.spawn(agentPath);

    // Phase 2 & 3: Initialize handshake
    await test.initialize();

    console.log('[test] ✓ HANDSHAKE COMPLETE');

    // Test execute
    await test.execute('Hello from PowPow!');

    // Graceful shutdown
    await test.shutdown();

    console.log('[test] ✓ ALL TESTS PASSED');
  } catch (e) {
    console.error('[test] ✗ FAILED:', e);
    process.exit(1);
  }
}

main();
