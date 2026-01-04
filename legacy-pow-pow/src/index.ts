#!/usr/bin/env node
/**
 * PowPow - Multi-agent chat for Claude Code
 *
 * Usage:
 *   npx powpow              Start server + human client
 *   npx powpow --client     Connect client to existing server
 *   npx powpow --server     Start server only (headless)
 *   npx powpow claude       Start Claude wrapper
 *   npx powpow ls           List channels
 *   npx powpow get <ch>     Get messages from channel
 *   npx powpow send <ch> <name> <msg>  Send a message
 *   npx powpow watch <ch>   Watch channel for messages
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POWPOW_URL = process.env.POWPOW_URL || "http://localhost:3131";

const args = process.argv.slice(2);
const transcriptFlag = args.includes("--transcript");
const filteredArgs = args.filter(a => a !== "--transcript");

// ─── CLI Operations ──────────────────────────────────────────────────────────

interface Channel { name: string; createdAt: string; }
interface Message { id: string; channel: string; sender: string; timestamp: string; content: string; }

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${POWPOW_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }
  return response.json();
}

async function cliListChannels() {
  const channels = await apiCall<Channel[]>("GET", "/api/channels");
  if (channels.length === 0) {
    console.log("No channels yet.");
    return;
  }
  console.log("Channels:");
  for (const ch of channels) {
    console.log(`  #${ch.name}`);
  }
}

async function cliGetMessages(channel: string, limit: number) {
  const query = limit ? `?limit=${limit}` : "";
  const messages = await apiCall<Message[]>(
    "GET",
    `/api/channels/${encodeURIComponent(channel)}/messages${query}`
  );
  if (messages.length === 0) {
    console.log(`No messages in #${channel}`);
    return;
  }
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    console.log(`[${time}] ${msg.sender}: ${msg.content}`);
  }
}

async function cliSendMessage(channel: string, sender: string, content: string) {
  const message = await apiCall<Message>(
    "POST",
    `/api/channels/${encodeURIComponent(channel)}/messages`,
    { sender, content }
  );
  console.log(`Sent to #${channel}`);
}

async function cliWatchChannel(channel: string) {
  console.log(`Watching #${channel} (Ctrl+C to stop)...`);
  const seenIds = new Set<string>();
  let initialized = false;

  const connect = async () => {
    try {
      const response = await fetch(
        `${POWPOW_URL}/api/channels/${encodeURIComponent(channel)}/stream`
      );
      const reader = response.body?.getReader();
      if (!reader) {
        setTimeout(connect, 3000);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.error("Stream ended, reconnecting...");
          setTimeout(connect, 1000);
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ") && currentEvent === "messages") {
            try {
              const messages: Message[] = JSON.parse(line.slice(6));
              if (!initialized) {
                messages.forEach((m) => seenIds.add(m.id));
                initialized = true;
                const recent = messages.slice(-3);
                for (const msg of recent) {
                  const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                  console.log(`[${time}] ${msg.sender}: ${msg.content}`);
                }
                console.log("--- live ---");
                continue;
              }
              for (const msg of messages) {
                if (!seenIds.has(msg.id)) {
                  seenIds.add(msg.id);
                  const time = new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                  console.log(`[${time}] ${msg.sender}: ${msg.content}`);
                }
              }
            } catch {}
          }
        }
      }
    } catch {
      console.error("Connection error, reconnecting...");
      setTimeout(connect, 3000);
    }
  };
  connect();
}

// ─── Command Router ──────────────────────────────────────────────────────────

// CLI commands
if (args[0] === "ls" || args[0] === "list-channels") {
  cliListChannels().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
else if (args[0] === "get" || args[0] === "get-messages" || args[0] === "messages") {
  const channel = args[1];
  if (!channel) {
    console.error("Usage: powpow get <channel> [--limit N]");
    process.exit(1);
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) || 50 : 50;
  cliGetMessages(channel, limit).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
else if (args[0] === "send") {
  const channel = args[1];
  const sender = args[2];
  const content = args.slice(3).join(" ");
  if (!channel || !sender || !content) {
    console.error("Usage: powpow send <channel> <sender> <message>");
    process.exit(1);
  }
  cliSendMessage(channel, sender, content).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
else if (args[0] === "watch") {
  const channel = args[1];
  if (!channel) {
    console.error("Usage: powpow watch <channel>");
    process.exit(1);
  }
  cliWatchChannel(channel);
}
// powpow claude [...args] → run the wrapper
else if (args[0] === "claude") {
  // Use compiled JS (when running from dist/, __dirname is dist/)
  const wrapperPath = path.join(__dirname, "wrapper", "index.js");
  const wrapperArgs = args.slice(1);

  const child = spawn("node", [wrapperPath, ...wrapperArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("exit", (code) => process.exit(code || 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
// powpow --client → client only
else if (args.includes("--client")) {
  const clientPath = path.join(__dirname, "client", "index.js");

  const child = spawn("node", [clientPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("exit", (code) => process.exit(code || 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
// powpow --server → server only
else if (filteredArgs.includes("--server")) {
  const serverPath = path.join(__dirname, "server", "index.js");
  const serverArgs = transcriptFlag ? ["--transcript"] : [];

  const child = spawn("node", [serverPath, ...serverArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("exit", (code) => process.exit(code || 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
// powpow → server + client (default)
else if (filteredArgs.length === 0 || filteredArgs[0] === "--help" || filteredArgs[0] === "-h") {
  if (filteredArgs[0] === "--help" || filteredArgs[0] === "-h") {
    console.log(`
PowPow - Multi-agent chat for Claude Code

Usage:
  powpow                        Start server + human client
  powpow --server               Start server only (headless)
  powpow --client               Connect client to existing server
  powpow claude                 Start Claude with PowPow wrapper

CLI Operations:
  powpow ls                     List all channels
  powpow get <channel>          Get messages from channel
  powpow send <ch> <name> <msg> Send a message
  powpow watch <channel>        Watch channel live

Examples:
  powpow ls
  powpow get general --limit 20
  powpow send general claude "Hello everyone!"
  powpow watch general

Environment:
  PORT         Server port (default: 3131)
  POWPOW_URL   Server URL (default: http://localhost:3131)
`);
    process.exit(0);
  }

  // Start server + client together
  const serverPath = path.join(__dirname, "server", "index.js");
  const clientPath = path.join(__dirname, "client", "index.js");
  const serverArgs = transcriptFlag ? ["--transcript"] : [];

  // Start server in background
  const server = spawn("node", [serverPath, ...serverArgs], {
    stdio: ["ignore", "ignore", "inherit"], // hide stdout, show stderr
    cwd: process.cwd(),
  });

  // Wait a moment for server to start
  setTimeout(() => {
    // Start client in foreground
    const client = spawn("node", [clientPath], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    client.on("exit", (code) => {
      server.kill();
      process.exit(code || 0);
    });

    process.on("SIGINT", () => {
      client.kill("SIGINT");
      server.kill("SIGINT");
    });
    process.on("SIGTERM", () => {
      client.kill("SIGTERM");
      server.kill("SIGTERM");
    });
  }, 500);
}
else {
  console.error(`Unknown command: ${args[0]}`);
  console.error("Run 'npx powpow --help' for usage");
  process.exit(1);
}
