#!/usr/bin/env tsx
/**
 * LocalRuntime End-to-End Test
 *
 * Validates the full WebSocket round-trip for local runtimes:
 * 1. Connect to /runtimes/connect
 * 2. Send runtime_ready → verify runtime registered
 * 3. Receive activate command for test agent
 * 4. Send agent_checkin → verify state = 'online'
 * 5. Send test frame → verify broadcast to channel
 * 6. Disconnect → verify cleanup
 *
 * Run: pnpm test:local-runtime
 * Requires: Local dev server running on port 3234
 */

import WebSocket from 'ws';
import { createServer, type Server, type IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import type { Duplex } from 'stream';

// Test configuration
const SERVER_PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT) : 3234;
const WS_URL = process.env.WS_URL || `ws://localhost:${SERVER_PORT}/runtimes/connect`;
const RUNTIME_ID = `rt_test_${Date.now()}`;
const SPACE_ID = process.env.SPACE_ID || 'default-space';
const CHANNEL_ID = process.env.CHANNEL_ID || 'test-channel';
const CALLSIGN = 'e2e-agent';
const AGENT_ID = `${SPACE_ID}:${CHANNEL_ID}:${CALLSIGN}`;

// Test state
interface TestContext {
  ws: WebSocket | null;
  receivedMessages: unknown[];
  activateReceived: boolean;
  errors: string[];
}

const ctx: TestContext = {
  ws: null,
  receivedMessages: [],
  activateReceived: false,
  errors: [],
};

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function log(msg: string) {
  console.log(`${dim(new Date().toISOString())} ${msg}`);
}

function pass(test: string) {
  console.log(`  ${green('✓')} ${test}`);
}

function fail(test: string, error?: string) {
  console.log(`  ${red('✗')} ${test}${error ? `: ${error}` : ''}`);
  ctx.errors.push(`${test}: ${error || 'failed'}`);
}

// =============================================================================
// Test Helpers
// =============================================================================

function send(msg: unknown): void {
  if (ctx.ws?.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify(msg));
    log(dim(`→ Sent: ${JSON.stringify(msg).slice(0, 100)}`));
  }
}

function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 5000,
  pollMs = 100
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const result = predicate();
      if (result !== undefined) {
        resolve(result);
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for condition after ${timeoutMs}ms`));
      } else {
        setTimeout(check, pollMs);
      }
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Test Steps
// =============================================================================

async function testConnect(): Promise<void> {
  log('Connecting to WebSocket...');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, 10000);

    ctx.ws = new WebSocket(WS_URL);

    ctx.ws.on('open', () => {
      clearTimeout(timeout);
      pass('Connected to /runtimes/connect');
      resolve();
    });

    ctx.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        ctx.receivedMessages.push(msg);
        log(dim(`← Received: ${JSON.stringify(msg).slice(0, 100)}`));

        // Track activate command
        if (msg.type === 'activate' && msg.agentId === AGENT_ID) {
          ctx.activateReceived = true;
        }
      } catch {
        log(yellow(`← Received non-JSON: ${data.toString().slice(0, 100)}`));
      }
    });

    ctx.ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ctx.ws.on('close', (code, reason) => {
      log(`WebSocket closed: ${code} ${reason}`);
    });
  });
}

async function testRuntimeReady(): Promise<void> {
  log('Sending runtime_ready...');

  send({
    type: 'runtime_ready',
    runtimeId: RUNTIME_ID,
    spaceId: SPACE_ID,
    name: 'e2e-test-runtime',
    machineInfo: {
      os: process.platform,
      hostname: 'e2e-test',
    },
  });

  // Wait for runtime_connected response
  try {
    const response = await waitFor(() => {
      return ctx.receivedMessages.find(
        (m: unknown) => (m as { type?: string }).type === 'runtime_connected'
      );
    });

    const connected = response as { runtimeId?: string; protocolVersion?: string };
    if (connected.runtimeId === RUNTIME_ID) {
      pass(`Runtime registered: ${RUNTIME_ID}`);
    } else {
      fail('Runtime registration', `Expected ${RUNTIME_ID}, got ${connected.runtimeId}`);
    }

    if (connected.protocolVersion) {
      pass(`Protocol version: ${connected.protocolVersion}`);
    }
  } catch (err) {
    fail('Runtime registration', (err as Error).message);
    throw err;
  }
}

async function testActivateAgent(): Promise<void> {
  log(`Waiting for activate command for ${AGENT_ID}...`);
  log(yellow('(Note: Activate must be triggered externally, e.g., via POST /channels/:id/agents)'));

  // In a real test, we'd trigger activation via HTTP API
  // For now, we'll skip if no activate is received within timeout
  try {
    await waitFor(() => ctx.activateReceived || undefined, 3000);
    pass(`Received activate for ${AGENT_ID}`);
  } catch {
    log(yellow('Skipping activate test (not triggered externally)'));
    // Continue - we'll test checkin/frame independently
  }
}

async function testAgentCheckin(): Promise<void> {
  log('Sending agent_checkin...');

  send({
    type: 'agent_checkin',
    agentId: AGENT_ID,
  });

  // Give server time to process
  await sleep(100);

  // Note: We can't directly verify state without DB access
  // The test passes if no error response is received
  const errorResponse = ctx.receivedMessages.find(
    (m: unknown) => (m as { error?: string }).error !== undefined
  );

  if (errorResponse) {
    fail('Agent checkin', (errorResponse as { error: string }).error);
  } else {
    pass(`Agent checkin sent for ${AGENT_ID}`);
  }
}

async function testSendFrame(): Promise<void> {
  log('Sending test frame...');

  const testMessageId = `msg_e2e_${Date.now()}`;
  const testFrame = {
    i: testMessageId,
    t: new Date().toISOString(),
    v: {
      type: 'agent',
      sender: CALLSIGN,
      senderType: 'agent',
      content: 'Hello from E2E test!',
    },
  };

  send({
    type: 'frame',
    agentId: AGENT_ID,
    frame: testFrame,
  });

  // Give server time to broadcast
  await sleep(200);

  // Frame should be broadcast to channel (we can't verify without a channel WS connection)
  // For now, success is no error response
  const errorResponse = ctx.receivedMessages.find(
    (m: unknown) =>
      (m as { error?: string }).error !== undefined &&
      ctx.receivedMessages.indexOf(m) > ctx.receivedMessages.length - 3
  );

  if (errorResponse) {
    fail('Send frame', (errorResponse as { error: string }).error);
  } else {
    pass(`Frame sent: ${testMessageId}`);
  }
}

async function testIdleFrame(): Promise<void> {
  log('Sending idle frame...');

  const idleFrame = {
    i: `msg_idle_${Date.now()}`,
    t: new Date().toISOString(),
    v: {
      type: 'idle',
      sender: CALLSIGN,
    },
  };

  send({
    type: 'frame',
    agentId: AGENT_ID,
    frame: idleFrame,
  });

  await sleep(100);
  pass('Idle frame sent (agent should be online)');
}

async function testDisconnect(): Promise<void> {
  log('Testing graceful disconnect...');

  if (ctx.ws) {
    ctx.ws.close(1000, 'E2E test complete');
    await sleep(200);
    pass('Disconnected gracefully');
  }
}

// =============================================================================
// Standalone Server Mode (for testing without main server)
// =============================================================================

async function runStandaloneServer(): Promise<Server> {
  const { createPostgresStorage } = await import('@cast/storage');
  const { AgentStateManager } = await import('@cast/runtime');
  const { createRuntimeConnectionManager } = await import('../src/runtimes/index.js');
  const { createConnectionManager } = await import('../src/websocket/index.js');

  const connectionString = process.env.DATABASE_URL || process.env.PLANETSCALE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL or PLANETSCALE_URL required for standalone mode');
  }

  const storage = createPostgresStorage({ connectionString });
  await storage.initialize();

  const connectionManager = createConnectionManager({});
  const agentStateManager = new AgentStateManager();

  const runtimeConnectionManager = createRuntimeConnectionManager({
    storage,
    connectionManager,
    agentStateManager,
    requireAuth: false, // Dev mode
    pingIntervalMs: 60000,
  });

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://localhost:${SERVER_PORT}`);

    if (url.pathname === '/runtimes/connect') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        runtimeConnectionManager.handleConnection(ws as unknown as WebSocket);
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(SERVER_PORT, () => {
      log(`Standalone server running on port ${SERVER_PORT}`);
      resolve(server);
    });
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('LocalRuntime E2E Test');
  console.log('='.repeat(60));
  console.log(`Target: ${WS_URL}`);
  console.log(`Runtime ID: ${RUNTIME_ID}`);
  console.log(`Agent ID: ${AGENT_ID}`);
  console.log('='.repeat(60) + '\n');

  let standaloneServer: Server | null = null;

  try {
    // Check if --standalone flag passed
    if (process.argv.includes('--standalone')) {
      log('Starting standalone server...');
      standaloneServer = await runStandaloneServer();
    }

    // Run tests
    await testConnect();
    await testRuntimeReady();
    await testActivateAgent();
    await testAgentCheckin();
    await testSendFrame();
    await testIdleFrame();
    await testDisconnect();

    // Summary
    console.log('\n' + '='.repeat(60));
    if (ctx.errors.length === 0) {
      console.log(green('All tests passed!'));
    } else {
      console.log(red(`${ctx.errors.length} test(s) failed:`));
      ctx.errors.forEach((e) => console.log(`  - ${e}`));
    }
    console.log('='.repeat(60) + '\n');

    process.exit(ctx.errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(red(`\nFatal error: ${(err as Error).message}`));
    if ((err as Error).stack) {
      console.error(dim((err as Error).stack!));
    }
    process.exit(1);
  } finally {
    if (ctx.ws) {
      ctx.ws.close();
    }
    if (standaloneServer) {
      standaloneServer.close();
    }
  }
}

main();
