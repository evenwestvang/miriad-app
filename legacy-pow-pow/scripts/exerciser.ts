#!/usr/bin/env npx tsx
/**
 * PowPow Exerciser - Stress test for the simplified channel architecture
 *
 * Tests:
 * - Multiple simultaneous SSE connections
 * - High message volume
 * - Connection stability over time
 * - Reconnection behavior
 *
 * Usage:
 *   npx tsx scripts/exerciser.ts [options]
 */

const POWPOW_URL = process.env.POWPOW_URL || "http://localhost:3131";

interface AgentStats {
  name: string;
  messagesReceived: number;
  messagesSent: number;
  connectCount: number;
  errorCount: number;
  lastActivity: number;
  connected: boolean;
}

interface GlobalStats {
  startTime: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  totalErrors: number;
  agents: Map<string, AgentStats>;
}

const stats: GlobalStats = {
  startTime: Date.now(),
  totalMessagesSent: 0,
  totalMessagesReceived: 0,
  totalErrors: 0,
  agents: new Map(),
};

function log(level: string, agent: string, message: string) {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] [${elapsed}s] [${level}] [${agent}] ${message}`);
}

function logStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const minutes = Math.floor(elapsed / 60);
  const seconds = Math.floor(elapsed % 60);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`STATS @ ${minutes}m ${seconds}s`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Messages: sent=${stats.totalMessagesSent} received=${stats.totalMessagesReceived}`);
  console.log(`Errors: ${stats.totalErrors}`);

  console.log(`\nAgent Status:`);
  for (const [name, agent] of stats.agents) {
    const lastSeen = ((Date.now() - agent.lastActivity) / 1000).toFixed(0);
    const status = agent.connected ? "✓" : "✗";
    console.log(`  ${status} ${name}: sent=${agent.messagesSent} recv=${agent.messagesReceived} conn=${agent.connectCount} err=${agent.errorCount} last=${lastSeen}s ago`);
  }
  console.log(`${"=".repeat(60)}\n`);
}

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${POWPOW_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

class SimulatedAgent {
  name: string;
  channel: string;
  controller: AbortController | null = null;
  running = false;
  seenIds = new Set<string>();

  constructor(name: string, channel: string) {
    this.name = name;
    this.channel = channel;

    stats.agents.set(name, {
      name,
      messagesReceived: 0,
      messagesSent: 0,
      connectCount: 0,
      errorCount: 0,
      lastActivity: Date.now(),
      connected: false,
    });
  }

  async start() {
    this.running = true;
    log("INFO", this.name, "Starting agent");
    this.connectSSE();
    this.sendLoop();
  }

  async stop() {
    this.running = false;
    if (this.controller) {
      this.controller.abort();
    }
    log("INFO", this.name, "Stopped");
  }

  // Force disconnect to test reconnection
  forceDisconnect() {
    if (this.controller) {
      log("CHAOS", this.name, "Forcing disconnect!");
      this.controller.abort();
      this.controller = null;
    }
  }

  getStats(): AgentStats {
    return stats.agents.get(this.name)!;
  }

  async connectSSE() {
    if (!this.running) return;

    this.controller = new AbortController();
    const agentStats = this.getStats();

    try {
      log("DEBUG", this.name, "Connecting to SSE stream...");
      const response = await fetch(
        `${POWPOW_URL}/api/channels/${encodeURIComponent(this.channel)}/stream`,
        { signal: this.controller.signal }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      agentStats.connected = true;
      agentStats.connectCount++;
      log("INFO", this.name, `SSE connected (connection #${agentStats.connectCount})`);

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let initialized = false;

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) {
          log("WARN", this.name, "SSE stream ended");
          break;
        }

        agentStats.lastActivity = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ") && currentEvent === "messages") {
            try {
              const messages = JSON.parse(line.slice(6));

              if (!initialized) {
                messages.forEach((m: { id: string }) => this.seenIds.add(m.id));
                initialized = true;
                log("DEBUG", this.name, `Initialized with ${messages.length} existing messages`);
                continue;
              }

              for (const msg of messages) {
                if (!this.seenIds.has(msg.id) && msg.sender !== this.name) {
                  this.seenIds.add(msg.id);
                  agentStats.messagesReceived++;
                  stats.totalMessagesReceived++;
                }
              }
            } catch {}
          } else if (line.startsWith(":ping")) {
            log("DEBUG", this.name, "Received keepalive ping");
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        log("ERROR", this.name, `SSE error: ${err}`);
        agentStats.errorCount++;
        stats.totalErrors++;
      }
    } finally {
      agentStats.connected = false;
    }

    // Reconnect if still running
    if (this.running) {
      log("INFO", this.name, "Reconnecting in 2s...");
      setTimeout(() => this.connectSSE(), 2000);
    }
  }

  async sendLoop() {
    while (this.running) {
      // Bursty behavior: 70% chance of long pause, 30% chance of rapid burst
      if (Math.random() < 0.7) {
        const pauseTime = 5000 + Math.random() * 25000;
        await this.sleep(pauseTime);
      } else {
        const burstSize = 2 + Math.floor(Math.random() * 5);
        for (let i = 0; i < burstSize && this.running; i++) {
          await this.sendMessage();
          await this.sleep(200 + Math.random() * 300);
        }
      }

      if (!this.running) break;
      await this.sendMessage();
    }
  }

  async sendMessage() {
    try {
      const content = `Test message #${this.getStats().messagesSent + 1} from ${this.name}`;
      await apiCall("POST", `/api/channels/${encodeURIComponent(this.channel)}/messages`, {
        sender: this.name,
        content,
      });
      this.getStats().messagesSent++;
      stats.totalMessagesSent++;
      this.getStats().lastActivity = Date.now();
    } catch (err) {
      log("ERROR", this.name, `Failed to send message: ${err}`);
      this.getStats().errorCount++;
      stats.totalErrors++;
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${POWPOW_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agents: 5,
    duration: 10,
    channel: "stress-test",
    chaos: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agents":
        opts.agents = parseInt(args[++i]) || opts.agents;
        break;
      case "--duration":
        opts.duration = parseInt(args[++i]) || opts.duration;
        break;
      case "--channel":
        opts.channel = args[++i] || opts.channel;
        break;
      case "--chaos":
        opts.chaos = true;
        break;
      case "--help":
        console.log(`
PowPow Exerciser - Stress test

Options:
  --agents N      Number of simulated agents (default: 5)
  --duration M    Test duration in minutes (default: 10)
  --channel NAME  Channel name (default: stress-test)
  --chaos         Enable chaos mode (random disconnects)
`);
        process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           PowPow Exerciser - Stress Test                   ║
╠════════════════════════════════════════════════════════════╣
║  Server:    ${POWPOW_URL.padEnd(44)}║
║  Agents:    ${String(opts.agents).padEnd(44)}║
║  Duration:  ${(opts.duration + " minutes").padEnd(44)}║
║  Channel:   ${opts.channel.padEnd(44)}║
║  Chaos:     ${(opts.chaos ? "ENABLED (random disconnects)" : "disabled").padEnd(44)}║
╚════════════════════════════════════════════════════════════╝
`);

  // Check server
  log("INFO", "main", "Checking server health...");
  if (!await checkServerHealth()) {
    log("ERROR", "main", `Cannot connect to server at ${POWPOW_URL}`);
    process.exit(1);
  }
  log("INFO", "main", "Server is healthy");

  // Create agents with callsign-style names
  const agents: SimulatedAgent[] = [];
  const adjectives = ["swift", "clever", "brave", "calm", "eager", "fierce"];
  const animals = ["fox", "owl", "bear", "wolf", "hawk", "lynx"];

  for (let i = 0; i < opts.agents; i++) {
    const adj = adjectives[i % adjectives.length];
    const animal = animals[i % animals.length];
    const name = `${adj}-${animal}`;
    agents.push(new SimulatedAgent(name, opts.channel));
  }

  // Start agents with staggered timing
  log("INFO", "main", `Starting ${agents.length} agents...`);
  for (const agent of agents) {
    await agent.start();
    await new Promise(r => setTimeout(r, 500));
  }

  // Stats logging interval
  const statsInterval = setInterval(logStats, 30000);

  // Chaos mode: randomly disconnect agents
  let chaosInterval: ReturnType<typeof setInterval> | null = null;
  if (opts.chaos) {
    log("CHAOS", "main", "Chaos mode enabled! Random disconnects every 5-15s");
    chaosInterval = setInterval(() => {
      const connectedAgents = agents.filter(a => a.controller !== null);
      if (connectedAgents.length > 0) {
        const victim = connectedAgents[Math.floor(Math.random() * connectedAgents.length)];
        victim.forceDisconnect();
      }
    }, 5000 + Math.random() * 10000);
  }

  // Run for duration
  const endTime = Date.now() + opts.duration * 60 * 1000;

  while (Date.now() < endTime) {
    await new Promise(r => setTimeout(r, 10000));

    // Check for stuck agents
    const now = Date.now();
    for (const [name, agentStats] of stats.agents) {
      const silentSeconds = (now - agentStats.lastActivity) / 1000;
      if (silentSeconds > 60) {
        log("WARN", name, `Agent silent for ${silentSeconds.toFixed(0)}s`);
      }
    }

    // Check server health
    if (!await checkServerHealth()) {
      log("ERROR", "main", "Server health check failed!");
    }

    // In chaos mode, schedule next random disconnect
    if (opts.chaos && chaosInterval) {
      clearInterval(chaosInterval);
      chaosInterval = setInterval(() => {
        const connectedAgents = agents.filter(a => a.controller !== null);
        if (connectedAgents.length > 0) {
          const victim = connectedAgents[Math.floor(Math.random() * connectedAgents.length)];
          victim.forceDisconnect();
        }
      }, 5000 + Math.random() * 10000);
    }
  }

  // Cleanup
  log("INFO", "main", "Test duration complete. Stopping agents...");
  clearInterval(statsInterval);
  if (chaosInterval) clearInterval(chaosInterval);

  for (const agent of agents) {
    await agent.stop();
  }

  // Final stats
  logStats();

  // Calculate total reconnects
  let totalReconnects = 0;
  for (const [, agentStats] of stats.agents) {
    totalReconnects += agentStats.connectCount - 1; // -1 for initial connect
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    TEST COMPLETE                           ║
╠════════════════════════════════════════════════════════════╣
║  Total Messages Sent:     ${String(stats.totalMessagesSent).padEnd(33)}║
║  Total Messages Received: ${String(stats.totalMessagesReceived).padEnd(33)}║
║  Total Reconnects:        ${String(totalReconnects).padEnd(33)}║
║  Total Errors:            ${String(stats.totalErrors).padEnd(33)}║
╚════════════════════════════════════════════════════════════╝
`);

  if (stats.totalErrors > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
