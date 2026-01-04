import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "crypto";
import { z } from "zod";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import {
  store,
  Message,
  ChannelAgent,
  ChannelMetadata,
  Artifact,
  Status,
  ResolvedAgent,
} from "./store.js";
import { AgentManager, SpawnContext, ManagedAgent } from "./agent-manager.js";
import { seedDefaults, seedRootArtifacts, migrateChannelAgentsToSlugs } from "./defaults.js";
import { NAME_THEMES } from "../shared/name-themes.js";
import { handleArtifactRequest, handleBoardsRequest, handleUploadRequest, wireArtifactSSE } from "./artifact-api.js";
import { wireAgentSSE } from "./firehose.js";
import { registerArtifactTools } from "./artifact-tools.js";
import { registerKBTools } from "./kb-tools.js";
import { initEmbeddings } from "./embeddings.js";
import {
  handleOAuthRequest,
  type OAuthApiDependencies,
  exchangeCodeForTokens,
  saveToken,
  getTokenStatus,
  deleteToken,
} from "./oauth/index.js";
import type { OAuthConfig } from "../shared/artifact-schemas.js";
import { sseManager, emitChannelsChanged, emitAgentsChanged } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3232;
const HOST = process.env.HOST || "127.0.0.1";
const TRANSCRIPT =
  process.argv.includes("--transcript") ||
  process.env.POWPOW_TRANSCRIPT === "1";

// Load config from ~/.cast/config.json (with fallback to legacy env var)
const CAST_DIR =
  process.env.CAST_DIR ||
  process.env.POWPOW_DIR ||
  path.join(os.homedir(), ".cast");
const CONFIG_PATH = path.join(CAST_DIR, "config.json");

interface ServerConfig {
  cors?: string[];
}

function loadConfig(): ServerConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch (e) {
    console.error(
      `[powpow] Warning: Could not load config from ${CONFIG_PATH}`,
    );
  }
  return {};
}

const config = loadConfig();
const allowedOrigins = new Set(config.cors || ["*"]);

// Multi-engine agent manager with provider registry (initialized async at startup)
let agentManager: AgentManager;

// Auto-spawn roster agents that are mentioned but not running
async function autoSpawnMentionedRosterAgents(message: Message) {
  // Extract all @mentions from message
  const mentions =
    message.content.match(/@([\w-]+)/g)?.map((m) => m.slice(1).toLowerCase()) ||
    [];
  if (mentions.length === 0) return;

  // Get roster for this channel
  const roster = store.listChannelAgents(message.channel);
  const rosterByName = new Map(roster.map((a) => [a.name.toLowerCase(), a]));

  // Get currently running agents (excluding stopped/error state)
  const activeAgents = agentManager.getAgents(message.channel)
    .filter((a) => a.state !== "stopped" && a.state !== "error");
  const runningAgents = new Set(
    activeAgents.map((a) => a.handle.name.toLowerCase()),
  );

  // Find roster agents that are mentioned but not running
  const toSpawn: ChannelAgent[] = [];
  for (const mention of mentions) {
    if (mention === "channel") continue; // Skip @channel
    if (runningAgents.has(mention)) continue; // Already running
    const rosterAgent = rosterByName.get(mention);
    if (rosterAgent) {
      toSpawn.push(rosterAgent);
    }
  }

  // Spawn them
  for (const agent of toSpawn) {
    console.error(
      `[powpow] Auto-spawning roster agent ${agent.name} (mentioned by ${message.sender})`,
    );
    console.error(
      `[powpow] Agent details: agentSlug=${agent.agentSlug}, channel=${message.channel}`,
    );

    // Build spawn context from agent artifact definition
    const spawnContext: SpawnContext = {};
    const agentDef = agent.agentSlug
      ? store.resolveAgentDefinition(message.channel, agent.agentSlug)
      : null;
    if (agentDef) {
      spawnContext.roleName = agentDef.name;
      spawnContext.roleInstructions = agentDef.content;
      spawnContext.engine = agentDef.engine;
      spawnContext.model = agentDef.model;
      spawnContext.mcp = agentDef.mcp;
    }
    const channelData = store.getChannel(message.channel);
    let initialPromptToSend: string | undefined;
    if (channelData?.metadata) {
      spawnContext.tagline = channelData.metadata.tagline;
      spawnContext.mission = channelData.metadata.mission;
      spawnContext.specialInstructions =
        channelData.metadata.specialInstructions;
      // Capture initialPrompt for kickoff message, then clear it from metadata
      if (channelData.metadata.initialPrompt) {
        initialPromptToSend = channelData.metadata.initialPrompt as string;
        spawnContext.initialPrompt = initialPromptToSend;
        store.updateChannelMetadata(message.channel, { initialPrompt: null } as ChannelMetadata);
      }
      // Note: playbookId is legacy - playbooks are now artifacts (type: system.playbook)
    }

    // Build roster with call signs and roles
    spawnContext.roster = roster.map((a) => {
      const def = a.agentSlug ? store.resolveAgentDefinition(message.channel, a.agentSlug) : null;
      return { name: a.name, role: def?.name || "Unknown" };
    });

    const mcpUrl = `http://localhost:${PORT}/mcp`;
    await agentManager.spawn(message.channel, agent.name, mcpUrl, spawnContext);
    ensureChannelForwarding(message.channel);

    // If there was an initialPrompt, send it as a kickoff message
    if (initialPromptToSend) {
      console.error(`[powpow] Sending initial prompt to @${agent.name}: ${initialPromptToSend}`);
      const kickoffMsg = store.addMessage(
        message.channel,
        "system",
        `@${agent.name} ${initialPromptToSend}`,
        false
      );
      logToTranscript(kickoffMsg);
    }
  }
}

// Process summon directives (@name+slug or @+slug) in message content
// Returns processed content with shorthand replaced by @mentions, and list of summoned agent names
async function processSummonDirectives(
  channelName: string,
  content: string,
  sender: string,
): Promise<{ processedContent: string; summonedAgents: string[] }> {
  let processedContent = content;
  const summonedAgents: string[] = [];

  // Pattern: @name+slug (spawn with specific name) or @+slug (auto-generate name)
  const spawnPattern = /@([\w-]*)\+([\w-]+)/g;
  const matches = [...content.matchAll(spawnPattern)];

  for (const match of matches) {
    const [fullMatch, specifiedName, slug] = match;

    // Find agent definition by slug (from artifacts)
    const agentDef = store.resolveAgentDefinition(channelName, slug);
    if (!agentDef) {
      console.error(`[powpow] Spawn shorthand: agent definition with slug "${slug}" not found`);
      continue;
    }

    // Determine agent name
    let agentName: string;
    if (specifiedName) {
      // User specified a name: @name+slug
      agentName = specifiedName;
    } else {
      // Auto-generate name: @+slug
      const existingAgents = store.listChannelAgents(channelName);
      const usedNames = new Set(existingAgents.map((a) => a.name));

      if (agentDef.agentName) {
        agentName = agentDef.agentName;
      } else if (agentDef.nameTheme && NAME_THEMES[agentDef.nameTheme]) {
        const theme = NAME_THEMES[agentDef.nameTheme];
        // Find next available name from theme
        agentName = theme[0];
        for (const name of theme) {
          if (!usedNames.has(name)) {
            agentName = name;
            break;
          }
        }
        // If all names used, add suffix
        if (usedNames.has(agentName)) {
          let counter = 2;
          const base = theme[0];
          while (usedNames.has(agentName)) {
            agentName = `${base}-${counter++}`;
          }
        }
      } else {
        const baseName = agentDef.name.toLowerCase().replace(/\s+/g, "-");
        agentName = baseName;
        let counter = 2;
        while (usedNames.has(agentName)) {
          agentName = `${baseName}-${counter++}`;
        }
      }
    }

    // Check if agent already exists in roster
    const existingAgent = store.getChannelAgent(channelName, agentName);
    if (!existingAgent) {
      // Add to roster with agentSlug for artifact resolution
      const agent: ChannelAgent = {
        channel: channelName,
        name: agentName,
        agentSlug: slug,
        engine: agentDef.engine || "claude",
        createdAt: new Date().toISOString(),
      };
      store.addChannelAgent(agent);
      console.error(`[powpow] Added ${agentName} (${agentDef.name}) to #${channelName} roster`);
    }

    // Spawn the agent
    const mcpUrl = `http://localhost:${PORT}/mcp`;
    const spawnContext: SpawnContext = {
      roleName: agentDef.name,
      roleInstructions: agentDef.content,
      engine: agentDef.engine,
      model: agentDef.model,
      mcp: agentDef.mcp,
    };

    // Add channel metadata to spawn context
    const channelData = store.getChannel(channelName);
    if (channelData?.metadata) {
      spawnContext.tagline = channelData.metadata.tagline;
      spawnContext.mission = channelData.metadata.mission;
      spawnContext.specialInstructions = channelData.metadata.specialInstructions;
      // Pass initialPrompt to first agent, then clear it from metadata
      if (channelData.metadata.initialPrompt) {
        spawnContext.initialPrompt = channelData.metadata.initialPrompt as string;
        store.updateChannelMetadata(channelName, { initialPrompt: null } as ChannelMetadata);
      }
    }

    // Build roster
    const roster = store.listChannelAgents(channelName);
    spawnContext.roster = roster.map((a) => {
      const def = a.agentSlug ? store.resolveAgentDefinition(channelName, a.agentSlug) : null;
      return { name: a.name, role: def?.name || "Unknown" };
    });

    await agentManager.spawn(channelName, agentName, mcpUrl, spawnContext);
    summonedAgents.push(agentName);

    // Replace shorthand with actual @mention in message
    processedContent = processedContent.replace(fullMatch, `@${agentName}`);
  }

  return { processedContent, summonedAgents };
}

// Forward messages to agents when they are @mentioned
function forwardMessageToAgents(message: Message) {
  // First, auto-spawn any mentioned roster agents that aren't running
  autoSpawnMentionedRosterAgents(message);

  const agents = agentManager.getAgents(message.channel);
  if (agents.length === 0) return;

  // Check for @channel (broadcast to all agents)
  const isBroadcast = /@channel\b/i.test(message.content);

  for (const agent of agents) {
    // Skip if the agent sent this message (don't echo back)
    if (agent.handle.name === message.sender) continue;

    // Check if this agent is @mentioned or it's a broadcast
    const isMentioned = new RegExp(`@${agent.handle.name}\\b`, "i").test(
      message.content,
    );

    if (isMentioned || isBroadcast) {
      console.error(
        `[agent-manager] Forwarding message from ${message.sender} to ${agent.handle.name}`,
      );
      agentManager.sendMessage(
        message.channel,
        agent.handle.name,
        `[Message from ${message.sender}]: ${message.content}`,
      );
    }
  }
}

// Generate channel agents from agent slugs
function generateAgentsFromCast(
  channel: string,
  agentSlugs: string[],
): ChannelAgent[] {
  const agents: ChannelAgent[] = [];
  const usedNames = new Set<string>();
  const themeCounters: Record<string, number> = {};

  for (const slug of agentSlugs) {
    const agentDef = store.resolveAgentDefinition(channel, slug);
    if (!agentDef) continue;

    let agentName: string;

    if (agentDef.agentName) {
      // Singleton with fixed name
      agentName = agentDef.agentName;
    } else if (agentDef.nameTheme && NAME_THEMES[agentDef.nameTheme]) {
      // Has a name theme - pick the next available name
      const themeKey = agentDef.nameTheme;
      const theme = NAME_THEMES[themeKey];
      const counter = themeCounters[themeKey] || 0;
      agentName = theme[counter % theme.length];
      themeCounters[themeKey] = counter + 1;
    } else {
      // Fallback: use name with counter
      const baseName = agentDef.name.toLowerCase().replace(/\s+/g, "-");
      let counter = 1;
      agentName = baseName;
      while (usedNames.has(agentName)) {
        agentName = `${baseName}-${counter++}`;
      }
    }

    // Ensure uniqueness
    if (usedNames.has(agentName)) {
      let counter = 2;
      const base = agentName;
      while (usedNames.has(agentName)) {
        agentName = `${base}-${counter++}`;
      }
    }
    usedNames.add(agentName);

    const agent: ChannelAgent = {
      channel,
      name: agentName,
      agentSlug: slug,
      engine: agentDef.engine || "claude",
      createdAt: new Date().toISOString(),
    };

    store.addChannelAgent(agent);
    agents.push(agent);
  }

  return agents;
}

// Track channel subscriptions for message forwarding
const channelForwardingSubscriptions = new Map<string, () => void>();

function ensureChannelForwarding(channel: string) {
  if (channelForwardingSubscriptions.has(channel)) return;

  let lastMessageId: string | null = null;

  const unsubscribe = store.subscribeToMessages(channel, () => {
    const messages = store.getMessages(channel, 1);
    if (messages.length > 0 && messages[0].id !== lastMessageId) {
      lastMessageId = messages[0].id;
      // Only forward regular messages, not structured_ask forms
      if (messages[0].type === "message") {
        forwardMessageToAgents(messages[0]);
      }
    }
  });

  channelForwardingSubscriptions.set(channel, unsubscribe);
}

// Transcript logging
const transcriptStreams = new Map<string, fs.WriteStream>();

function logToTranscript(message: Message) {
  if (!TRANSCRIPT) return;

  let stream = transcriptStreams.get(message.channel);
  if (!stream) {
    const filename = `powpow-${message.channel}.log`;
    stream = fs.createWriteStream(filename, { flags: "a" });
    transcriptStreams.set(message.channel, stream);
    console.error(`[transcript] ${path.resolve(filename)}`);
  }

  const timestamp = new Date(message.timestamp).toLocaleString();
  stream.write(`[${timestamp}] ${message.sender}: ${message.content}\n`);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "powpow",
    version: "0.1.0",
  });

  // Tools

  server.tool("list_channels", "List all available channels", {}, async () => {
    const channels = store.listChannels();
    return {
      content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
    };
  });

  server.tool(
    "track_channel",
    `Start tracking a channel to receive live message updates. Your callsign was provided when you started - use it when sending messages.

IMPORTANT: Use set_status frequently to let others know what you're working on. Update it as your work evolves (e.g., "researching auth options" → "implementing JWT flow" → "writing tests").

Note: If you're not receiving messages, make sure you're running via the PowPow wrapper.`,
    {
      channel: z
        .string()
        .describe("Channel name to track (e.g., 'general', 'dev-team')"),
    },
    async ({ channel }) => {
      // This tool is a no-op on the server - it exists so the wrapper can detect
      // when Claude wants to track a channel and set up the SSE stream
      const ch = store.getOrCreateChannel(channel);
      const messages = store.getMessages(channel, 20);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tracking: true,
                channel: ch,
                recentMessages: messages,
                note: "You are now tracking this channel. You'll receive messages when someone @mentions your callsign or uses @channel. Remember to use set_status to share what you're working on!",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "send_message",
    `Send a message to a channel. Use @mentions to address others:
• @callsign - notify a specific agent (e.g., "@swift-fox can you help?")
• @channel - broadcast to all tracking this channel
Messages without @mentions are logged but not pushed to anyone.`,
    {
      channel: z.string().describe("Channel name to send to"),
      sender: z.string().describe("Your callsign (e.g., 'swift-fox')"),
      content: z
        .string()
        .describe(
          "Message content. Use @callsign or @channel to notify others.",
        ),
    },
    async ({ channel, sender, content }) => {
      // Check for @mentions
      const hasMention = /@[\w-]+/.test(content);
      if (!hasMention) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "ERROR: Message must include @mention (e.g., @someone or @channel). Messages without @mentions are not delivered to anyone.",
            },
          ],
        };
      }

      const message = store.addMessage(channel, sender, content);
      logToTranscript(message);
      return {
        content: [{ type: "text", text: JSON.stringify(message, null, 2) }],
      };
    },
  );

  server.tool(
    "get_messages",
    "Get recent messages from a channel",
    {
      channel: z.string().describe("Channel name"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of messages to return (default: 50)"),
    },
    async ({ channel, limit }) => {
      const messages = store.getMessages(channel, limit || 50);
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  server.tool(
    "set_status",
    "Update your status to let others know what you're working on. Keep it short (a few words). Update frequently as your work progresses. This will post a status update to the channel.",
    {
      channel: z.string().describe("Channel to post status update to"),
      sender: z.string().describe("Your callsign"),
      status: z
        .string()
        .describe(
          "Brief status (e.g., 'reviewing PR #123', 'fixing auth bug', 'waiting for feedback')",
        ),
    },
    async ({ channel, sender, status }) => {
      setParticipantStatus(sender, status);
      // Post status change to channel
      const message = store.addMessage(channel, sender, `→ ${status}`);
      logToTranscript(message);
      return {
        content: [{ type: "text", text: `Status updated: ${status}` }],
      };
    },
  );

  /// Artifact tools - 9 tools per spec: glob, read, create, edit, update, list, archive, checkpoint, diff
  registerArtifactTools(server);

  // Knowledge Base tools - kb_list, kb_glob, kb_read, kb_query
  registerKBTools(server);

  return server;
}

// HTTP Server for MCP over Streamable HTTP + REST endpoints
// Each session has its own transport and MCP server instance
const mcpSessions = new Map<string, {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}>();
let connectionCounter = 0;
const sseConnections = new Set<string>();
let sseConnectionCounter = 0;
const serverStartTime = Date.now();

// Track active participants per channel (sseId -> { sender, connectedAt })
const activeParticipants = new Map<
  string,
  Map<string, { sender: string; connectedAt: number }>
>();

// Track status per sender (global, not per-channel)
const participantStatus = new Map<string, string>();

function getChannelParticipants(
  channel: string,
): { sender: string; connectedAt: number; status?: string }[] {
  const participants = activeParticipants.get(channel);
  if (!participants) return [];
  return Array.from(participants.values()).map((p) => ({
    ...p,
    status: participantStatus.get(p.sender),
  }));
}

function setParticipantStatus(sender: string, status: string): void {
  participantStatus.set(sender, status);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  // CORS headers - check origin against allowed list
  const origin = req.headers.origin;
  if (allowedOrigins.has("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health endpoint
  if (url.pathname === "/api/health" && req.method === "GET") {
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const channels = store.listChannels();
    const channelStats = channels.map((c) => ({
      name: c.name,
      messages: store.getMessages(c.name).length,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          uptime: uptimeSeconds,
          mcpSessions: mcpSessions.size,
          sseConnections: sseConnections.size,
          centralSSE: sseManager.getStats(),
          channels: channelStats,
          memory: process.memoryUsage(),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Central SSE stream for invalidation events (channels, agents)
  // Use this instead of polling for real-time updates
  if (url.pathname === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const clientId = sseManager.addClient(res);

    // Send initial connected event
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

    req.on("close", () => {
      sseManager.removeClient(clientId);
    });

    return;
  }

  // MCP Streamable HTTP endpoint (unified GET/POST/DELETE)
  if (url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Handle DELETE - session termination
    if (req.method === "DELETE") {
      if (sessionId && mcpSessions.has(sessionId)) {
        const session = mcpSessions.get(sessionId)!;
        await session.transport.close();
        mcpSessions.delete(sessionId);
        console.error(`MCP session terminated: ${sessionId}`);
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    // Handle GET/POST
    if (req.method === "GET" || req.method === "POST") {
      let session = sessionId ? mcpSessions.get(sessionId) : undefined;

      // Create new session for POST without session ID (initialization)
      if (!session && req.method === "POST") {
        const connectionId = `mcp_${++connectionCounter}`;
        const remoteAddr = req.socket.remoteAddress;
        const remotePort = req.socket.remotePort;
        const userAgent = req.headers["user-agent"] || "unknown";
        const referer = req.headers["referer"] || req.headers["origin"] || "none";
        console.error(`New MCP connection: ${connectionId}`);
        console.error(`  From: ${remoteAddr}:${remotePort}`);
        console.error(`  User-Agent: ${userAgent}`);
        console.error(`  Referer/Origin: ${referer}`);
        console.error(`  Server PORT: ${PORT}`);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);

        session = { transport, server: mcpServer };

        // We'll store the session after handling the request (session ID comes from transport)
      }

      // Existing session required for GET or subsequent POST
      if (!session && req.method === "GET") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session ID required for GET requests" }));
        return;
      }

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      // Parse body for POST
      let parsedBody: unknown = undefined;
      const isNewSession = !sessionId;
      if (req.method === "POST") {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
        });
        try {
          parsedBody = JSON.parse(body);
          // Log initialization message for new sessions
          if (isNewSession && parsedBody && typeof parsedBody === "object") {
            const msg = parsedBody as Record<string, unknown>;
            if (msg.method === "initialize" && msg.params) {
              const params = msg.params as Record<string, unknown>;
              console.error(`  Client info: ${JSON.stringify(params.clientInfo || "none")}`);
            }
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
      }

      try {
        await session.transport.handleRequest(req, res, parsedBody);

        // Store new session after successful request
        const newSessionId = session.transport.sessionId;
        if (newSessionId && !mcpSessions.has(newSessionId)) {
          mcpSessions.set(newSessionId, session);
          console.error(`  MCP Session created: ${newSessionId}`);

          // Clean up session when transport closes
          session.transport.onclose = () => {
            console.error(`MCP session closed: ${newSessionId}`);
            mcpSessions.delete(newSessionId);
          };
        }
      } catch (err) {
        console.error(`Error handling MCP request:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal error" }));
        }
      }
      return;
    }

    // Method not allowed
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Legacy SSE endpoint - redirect to new endpoint
  if (url.pathname === "/mcp/sse" && req.method === "GET") {
    res.writeHead(301, { "Location": "/mcp" });
    res.end();
    return;
  }

  // REST API for human clients

  // GET /api/channels - list channels
  if (url.pathname === "/api/channels" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(store.listChannels()));
    return;
  }

  // GET /api/focus-types - list available focus types for channel creation
  if (url.pathname === "/api/focus-types" && req.method === "GET") {
    const focusTypes = store.listArtifacts("root", {
      type: "system.focus",
      status: "published",
    }).map(f => ({
      slug: f.slug,
      title: f.title || f.slug,
      tldr: f.tldr,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(focusTypes));
    return;
  }

  // POST /api/channels - create a channel with optional metadata and focus
  if (url.pathname === "/api/channels" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { name, metadata, focus } = JSON.parse(body);
        if (!name || typeof name !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Channel name is required" }));
          return;
        }
        if (!metadata?.createdBy) {
          console.error(`[powpow] Channel creation rejected - missing createdBy. Metadata:`, JSON.stringify(metadata, null, 2));
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "metadata.createdBy is required" }));
          return;
        }

        // Resolve focus if provided
        let focusArtifact: Artifact | undefined;
        let focusProps: { agents?: string[]; defaultTagline?: string; defaultMission?: string; initialPrompt?: string } = {};

        if (focus) {
          focusArtifact = store.getArtifact("root", focus);
          if (!focusArtifact) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Focus '${focus}' not found in #root` }));
            return;
          }
          if (focusArtifact.type !== "system.focus") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Artifact '${focus}' is not a system.focus (got ${focusArtifact.type})` }));
            return;
          }
          focusProps = (focusArtifact.props || {}) as typeof focusProps;
        }

        // Build enriched metadata
        const enrichedMetadata = { ...metadata };

        // Inject focus content into specialInstructions
        if (focusArtifact) {
          const focusInstructions = focusArtifact.content;
          enrichedMetadata.specialInstructions = focusInstructions +
            (metadata.specialInstructions ? "\n\n" + metadata.specialInstructions : "");
        }

        // Seed tagline from focus defaults (if not provided)
        if (focusProps.defaultTagline && !metadata.tagline) {
          enrichedMetadata.tagline = focusProps.defaultTagline;
        }

        // Seed mission from focus defaults (if not provided)
        if (focusProps.defaultMission && !metadata.mission) {
          enrichedMetadata.mission = focusProps.defaultMission;
        }

        // Store initialPrompt in metadata (for injection into first agent's context)
        if (focusProps.initialPrompt) {
          enrichedMetadata.initialPrompt = focusProps.initialPrompt;
        }

        const channel = store.createChannel(name, enrichedMetadata);
        console.error(`[powpow] Created channel: ${name}${focus ? ` with focus: ${focus}` : ''}`);
        console.error(`[powpow] Channel creation metadata:`, JSON.stringify(enrichedMetadata, null, 2));

        // Determine which agents to summon
        const agentSlugs = focusProps.agents || ["lead"];  // Default to lead if no focus

        // Generate and add agents to roster
        const agents = generateAgentsFromCast(name, agentSlugs);
        console.error(`[powpow] Added ${agents.length} agent(s) to #${name}: ${agents.map(a => a.name).join(", ")}`);

        // Spawn the agents immediately
        const mcpUrl = `http://localhost:${PORT}/mcp`;
        for (const agent of agents) {
          const agentDef = agent.agentSlug
            ? store.resolveAgentDefinition(name, agent.agentSlug)
            : null;
          const spawnContext: SpawnContext = {
            tagline: enrichedMetadata.tagline,
            mission: enrichedMetadata.mission,
            specialInstructions: enrichedMetadata.specialInstructions,
            initialPrompt: focusProps.initialPrompt,
            roster: agents.map((a) => {
              const def = a.agentSlug ? store.resolveAgentDefinition(name, a.agentSlug) : null;
              return { name: a.name, role: def?.name || "Unknown" };
            }),
          };
          if (agentDef) {
            spawnContext.roleName = agentDef.name;
            spawnContext.roleInstructions = agentDef.content;
            spawnContext.engine = agentDef.engine;
            spawnContext.model = agentDef.model;
            spawnContext.mcp = agentDef.mcp;
          }
          await agentManager.spawn(name, agent.name, mcpUrl, spawnContext);
        }
        if (agents.length > 0) {
          ensureChannelForwarding(name);
        }

        // Send the initial prompt directly to the first agent (not visible in chat)
        if (focusProps.initialPrompt && agents.length > 0) {
          const firstAgent = agents[0];
          console.error(`[powpow] Sending initial prompt to ${firstAgent.name}: ${focusProps.initialPrompt}`);
          agentManager.sendMessage(name, firstAgent.name, focusProps.initialPrompt);
          // Clear initialPrompt from metadata since we've used it
          store.updateChannelMetadata(name, { initialPrompt: null } as ChannelMetadata);
        }

        // Copy focus children to board
        if (focusArtifact) {
          const copyResult = store.copyFocusChildren(focus, name, "system");
          if (copyResult.copied.length > 0) {
            console.error(`[powpow] Copied ${copyResult.copied.length} artifact(s) from focus to #${name}`);
          }
        }

        // Emit SSE event for channel creation
        emitChannelsChanged(name);

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(channel));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // POST /api/channels/:name/archive - archive a channel
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/archive$/) &&
    req.method === "POST"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const success = store.archiveChannel(channelName);
    if (success) {
      console.error(`[powpow] Archived channel: ${channelName}`);
      emitChannelsChanged(channelName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ success: true, message: `Archived #${channelName}` }),
      );
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
    }
    return;
  }

  // POST /api/channels/:name/unarchive - unarchive a channel
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/unarchive$/) &&
    req.method === "POST"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const success = store.unarchiveChannel(channelName);
    if (success) {
      console.error(`[powpow] Unarchived channel: ${channelName}`);
      emitChannelsChanged(channelName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          message: `Unarchived #${channelName}`,
        }),
      );
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
    }
    return;
  }

  // GET /api/channels/:name/agents - get channel agents (roster)
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/agents$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    // Include dismissed agents so frontend can show warnings
    const agents = store.listChannelAgents(channelName, true);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agents));
    return;
  }

  // POST /api/channels/:name/agents - add a channel agent
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/agents$/) &&
    req.method === "POST"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { agentSlug } = JSON.parse(body);
        if (!agentSlug) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "agentSlug is required" }));
          return;
        }
        const slug = agentSlug;

        // Find agent definition from artifacts
        const agentDef = store.resolveAgentDefinition(channelName, slug);

        if (!agentDef) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Agent definition not found" }));
          return;
        }

        // Generate agent name
        const existingAgents = store.listChannelAgents(channelName);
        const usedNames = new Set(existingAgents.map((a) => a.name));

        let agentName: string;

        if (agentDef.agentName) {
          agentName = agentDef.agentName;
        } else if (agentDef.nameTheme && NAME_THEMES[agentDef.nameTheme]) {
          const themeKey = agentDef.nameTheme;
          const theme = NAME_THEMES[themeKey];
          // Find next available name from theme
          for (const name of theme) {
            if (!usedNames.has(name)) {
              agentName = name;
              break;
            }
          }
          // If all names used, add suffix
          if (!agentName!) {
            let counter = 2;
            agentName = theme[0];
            while (usedNames.has(agentName)) {
              agentName = `${theme[0]}-${counter++}`;
            }
          }
        } else {
          const baseName = agentDef.name.toLowerCase().replace(/\s+/g, "-");
          agentName = baseName;
          let counter = 2;
          while (usedNames.has(agentName)) {
            agentName = `${baseName}-${counter++}`;
          }
        }

        const agent: ChannelAgent = {
          channel: channelName,
          name: agentName,
          agentSlug: slug,
          engine: agentDef.engine || "claude",
          createdAt: new Date().toISOString(),
        };

        store.addChannelAgent(agent);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(agent));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // DELETE /api/channels/:name/agents/:agentName - remove a channel agent
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/agents\/[^/]+$/) &&
    req.method === "DELETE"
  ) {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const agentName = decodeURIComponent(parts[5]);
    const success = store.removeChannelAgent(channelName, agentName);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success }));
    return;
  }

  // GET /api/channels/:name/agent-types - list available agent types for spawning
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/agent-types$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const agents = store.listAvailableAgentTypes(channelName);
    // Return simplified format matching MCP tool output
    const result = agents.map(a => ({
      slug: a.slug,
      name: a.name,
      engine: a.engine || "claude",
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      channel: channelName,
      availableAgents: result,
      count: result.length,
    }));
    return;
  }

  // POST /api/channels/:name/start - start all channel agents
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/start$/) &&
    req.method === "POST"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const roster = store.listChannelAgents(channelName);

    if (roster.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No agents in roster", started: [] }));
      return;
    }

    // Post system message
    const systemMsg = store.addMessage(
      channelName,
      "system",
      "Summoning cast.",
      false,
    );
    logToTranscript(systemMsg);

    // Build spawn context from channel metadata
    const channelData = store.getChannel(channelName);
    const baseContext: SpawnContext = {};
    let initialPromptForFirstAgent: string | undefined;
    if (channelData?.metadata) {
      baseContext.tagline = channelData.metadata.tagline;
      baseContext.mission = channelData.metadata.mission;
      baseContext.specialInstructions =
        channelData.metadata.specialInstructions;
      // Capture initialPrompt for first agent only
      if (channelData.metadata.initialPrompt) {
        initialPromptForFirstAgent = channelData.metadata.initialPrompt as string;
        store.updateChannelMetadata(channelName, { initialPrompt: null } as ChannelMetadata);
      }
      // Note: playbookId is legacy - playbooks are now artifacts (type: system.playbook)
    }

    // Build roster with call signs and roles for context
    baseContext.roster = roster.map((a) => {
      const def = a.agentSlug ? store.resolveAgentDefinition(channelName, a.agentSlug) : null;
      return { name: a.name, role: def?.name || "Unknown" };
    });

    const mcpUrl = `http://localhost:${PORT}/mcp`;
    const started: string[] = [];
    const errors: string[] = [];

    // Spawn all agents
    (async () => {
      let isFirstSpawn = true;
      for (const agent of roster) {
        // Check if already running
        if (agentManager.getAgent(channelName, agent.name)) {
          continue;
        }

        const spawnContext = { ...baseContext };
        const agentDef = agent.agentSlug ? store.resolveAgentDefinition(channelName, agent.agentSlug) : null;
        if (agentDef) {
          spawnContext.roleName = agentDef.name;
          spawnContext.roleInstructions = agentDef.content;
          spawnContext.engine = agentDef.engine;
          spawnContext.model = agentDef.model;
          spawnContext.mcp = agentDef.mcp;
        }
        // Pass initialPrompt to first agent only
        if (isFirstSpawn && initialPromptForFirstAgent) {
          spawnContext.initialPrompt = initialPromptForFirstAgent;
          isFirstSpawn = false;
        }

        const result = await agentManager.spawn(
          channelName,
          agent.name,
          mcpUrl,
          spawnContext,
        );
        if (result.success) {
          started.push(agent.name);
        } else {
          errors.push(`${agent.name}: ${result.message}`);
        }
      }

      if (started.length > 0) {
        ensureChannelForwarding(channelName);

        // If there was an initialPrompt, post it as a system message mentioning the first agent
        if (initialPromptForFirstAgent && started.length > 0) {
          const firstAgent = started[0];
          console.error(`[powpow] Sending initial prompt to @${firstAgent}: ${initialPromptForFirstAgent}`);
          const kickoffMsg = store.addMessage(
            channelName,
            "system",
            `@${firstAgent} ${initialPromptForFirstAgent}`,
            false
          );
          logToTranscript(kickoffMsg);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          started,
          errors: errors.length > 0 ? errors : undefined,
          message:
            started.length > 0
              ? `Started ${started.join(", ")}`
              : "No agents started",
        }),
      );
    })();
    return;
  }

  // GET /api/channels/:name/metadata - get channel metadata
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/metadata$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const metadata = store.getChannelMetadata(channelName);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(metadata || {}));
    return;
  }

  // PUT /api/channels/:name/metadata - update channel metadata
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/metadata$/) &&
    req.method === "PUT"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const metadata = JSON.parse(body);
        const success = store.updateChannelMetadata(channelName, metadata);
        if (success) {
          console.error(`[powpow] Updated metadata for #${channelName}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              metadata: store.getChannelMetadata(channelName),
            }),
          );
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Channel not found" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // GET /api/channels/:name/messages - get messages
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/messages$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(store.getMessages(channelName, limit)));
    return;
  }

  // POST /api/channels/:name/messages - send message
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/messages$/) &&
    req.method === "POST"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { sender, content } = JSON.parse(body);
        if (!sender || !content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sender and content required" }));
          return;
        }
        // Ensure forwarding is set up before adding message (for auto-spawn)
        ensureChannelForwarding(channelName);
        // Check if sender is an agent (not a user)
        const isAgent =
          agentManager.getAgent(channelName, sender) !== undefined;

        // If sender is an agent, check for @-mentions of dismissed agents and reject
        if (isAgent) {
          const mentionCheck = /@([\w-]+)/g;
          const mentions = [...content.matchAll(mentionCheck)];
          const dismissedMentions: string[] = [];

          for (const match of mentions) {
            const mentionedName = match[1];
            if (mentionedName === 'channel') continue;
            const mentionedAgent = store.getChannelAgent(channelName, mentionedName);
            if (mentionedAgent?.dismissed) {
              dismissedMentions.push(mentionedName);
            }
          }

          if (dismissedMentions.length > 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: `Cannot message dismissed agent(s): ${dismissedMentions.map(n => `@${n}`).join(", ")}. They must be re-summoned by a human first.`
            }));
            return;
          }
        }

        // Handle /dismiss command: /dismiss @agent1 @agent2 ...
        const dismissMatch = content.match(/^\/dismiss\s+(.+)/i);
        if (dismissMatch) {
          const agentMentions = dismissMatch[1].match(/@([\w-]+)/g) || [];
          const dismissedNames: string[] = [];

          for (const mention of agentMentions) {
            const agentName = mention.slice(1); // Remove @
            const agent = store.getChannelAgent(channelName, agentName);
            if (agent && !agent.dismissed) {
              // Kick the agent if running
              agentManager.kick(channelName, agentName);
              // Mark as dismissed in roster
              store.dismissChannelAgent(channelName, agentName);
              dismissedNames.push(agentName);
              console.error(`[powpow] Dismissed ${agentName} from #${channelName}`);
            }
          }

          if (dismissedNames.length > 0) {
            const systemMsg = store.addMessage(
              channelName,
              "system",
              `@${sender} dismissed ${dismissedNames.map((n) => `@${n}`).join(", ")}`,
              false,
            );
            logToTranscript(systemMsg);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, dismissed: dismissedNames }));
          return;
        }

        // Process summon shorthand: @+slug or @name+slug
        const { processedContent, summonedAgents } = await processSummonDirectives(
          channelName,
          content,
          sender,
        );

        // Check for @-mentions of dismissed agents and un-dismiss them
        // (the existing auto-spawn logic will handle spawning)
        const mentionPattern = /@([\w-]+)/g;
        const mentionMatches = [...processedContent.matchAll(mentionPattern)];

        for (const match of mentionMatches) {
          const agentName = match[1];
          if (agentName === 'channel') continue;

          const agent = store.getChannelAgent(channelName, agentName);
          if (agent && agent.dismissed) {
            store.undismissChannelAgent(channelName, agentName);
            console.error(`[powpow] Un-dismissed agent ${agentName} in #${channelName}`);
          }
        }

        // Post system message about summoned agents
        if (summonedAgents.length > 0) {
          const systemMsg = store.addMessage(
            channelName,
            "system",
            `@${sender} added ${summonedAgents.map((n) => `@${n}`).join(", ")}`,
            false,
          );
          logToTranscript(systemMsg);
        }

        // Auto-address to point agent (first in roster) if user message has no @-mentions
        let finalContent = processedContent;
        if (!isAgent && !/@[\w-]+/.test(finalContent)) {
          const roster = store.listChannelAgents(channelName);
          // Sort by createdAt to get point agent (first added)
          roster.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const pointAgent = roster[0]?.name || "lead";
          finalContent = `@${pointAgent} ${finalContent}`;
        }
        const message = store.addMessage(
          channelName,
          sender,
          finalContent,
          !isAgent,
        );
        logToTranscript(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(message));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Get active participants in a channel
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/participants$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const participants = getChannelParticipants(channelName);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(participants));
    return;
  }

  // POST /api/channels/:channel/structured-ask/:messageId/submit - submit structured ask response
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/structured-ask\/[^/]+\/submit$/) &&
    req.method === "POST"
  ) {
    const parts = url.pathname.split("/");
    const channelName = decodeURIComponent(parts[3]);
    const messageId = decodeURIComponent(parts[5]);

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { respondedBy, response } = JSON.parse(body);
        if (!respondedBy || !response) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "respondedBy and response are required" }));
          return;
        }

        const updatedMessage = store.submitStructuredAskResponse(messageId, respondedBy, response);

        if (!updatedMessage) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Structured ask not found, already submitted, or invalid" }));
          return;
        }

        // Post a human-readable response message to the channel
        const formData = updatedMessage.formData;
        const responseLines: string[] = [];
        const summonLines: string[] = [];

        for (const field of formData.fields) {
          const value = response[field.id];
          if (field.type === "summon_request" && field.agents) {
            // summon_request values are arrays of approved callsigns
            const approvedCallsigns = Array.isArray(value) ? value : (value ? [value] : []);
            // Build summon directives by looking up definitionSlug from agents array
            for (const callsign of approvedCallsigns) {
              const agent = field.agents.find(a => a.callsign === callsign);
              if (agent) {
                // Format as summon directive: @callsign+definitionSlug
                summonLines.push(`@${agent.callsign}+${agent.definitionSlug}`);
              }
            }
          } else {
            const displayValue = Array.isArray(value) ? value.join(", ") : (value || "(empty)");
            responseLines.push(`- ${field.label}: ${displayValue}`);
          }
        }

        // Build response message with summon directives at the end
        let responseContent = `@${updatedMessage.sender} Re: "${formData.prompt}"`;
        if (responseLines.length > 0) {
          responseContent += `\n\n${responseLines.join("\n")}`;
        }
        if (summonLines.length > 0) {
          responseContent += `\n\nSummoning: ${summonLines.join(" ")}`;
        }

        // Process summon directives in the response message
        const { processedContent, summonedAgents } = await processSummonDirectives(
          channelName,
          responseContent,
          respondedBy,
        );

        // Save the message with summons resolved to @mentions
        // Form responses are user actions, so isAgent=false to trigger dormant agent waking
        const savedMessage = store.addMessage(channelName, respondedBy, processedContent, false);
        logToTranscript(savedMessage);

        // Post system message about summoned agents
        if (summonedAgents.length > 0) {
          const systemMsg = store.addMessage(
            channelName,
            "system",
            `@${respondedBy} added ${summonedAgents.map((n) => `@${n}`).join(", ")}`,
            false,
          );
          logToTranscript(systemMsg);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          message: updatedMessage,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Update participant status
  if (url.pathname === "/api/status" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { sender, status } = JSON.parse(body);
        if (!sender || typeof status !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sender and status required" }));
          return;
        }
        setParticipantStatus(sender, status);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Spawn an agent (SDK-based)
  if (url.pathname === "/api/agents/spawn" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { channel, name, engine } = JSON.parse(body);
        if (!channel || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "channel and name required" }));
          return;
        }

        // Build spawn context from channel agent and channel metadata
        const spawnContext: SpawnContext = {};

        // Look up channel agent to get agent definition
        const channelAgent = store.getChannelAgent(channel, name);
        if (channelAgent) {
          const agentDef = channelAgent.agentSlug ? store.resolveAgentDefinition(channel, channelAgent.agentSlug) : null;
          if (agentDef) {
            spawnContext.roleName = agentDef.name;
            spawnContext.roleInstructions = agentDef.content;
            spawnContext.engine = agentDef.engine;
            spawnContext.model = agentDef.model;
            spawnContext.mcp = agentDef.mcp;
          }
        }

        // Allow engine override from request body
        if (engine) {
          spawnContext.engine = engine;
        }

        // Look up channel metadata for mission, tagline, special instructions
        const channelData = store.getChannel(channel);
        if (channelData?.metadata) {
          spawnContext.tagline = channelData.metadata.tagline;
          spawnContext.mission = channelData.metadata.mission;
          spawnContext.specialInstructions =
            channelData.metadata.specialInstructions;
          // Pass initialPrompt to first agent, then clear it from metadata
          if (channelData.metadata.initialPrompt) {
            spawnContext.initialPrompt = channelData.metadata.initialPrompt as string;
            store.updateChannelMetadata(channel, { initialPrompt: null } as ChannelMetadata);
          }
          // Note: playbookId is legacy - playbooks are now artifacts (type: system.playbook)
        }

        // Build roster with call signs and roles
        const roster = store.listChannelAgents(channel);
        spawnContext.roster = roster.map((a) => {
          const def = a.agentSlug ? store.resolveAgentDefinition(channel, a.agentSlug) : null;
          return { name: a.name, role: def?.name || "Unknown" };
        });

        const mcpUrl = `http://localhost:${PORT}/mcp`;
        const result = await agentManager.spawn(
          channel,
          name,
          mcpUrl,
          spawnContext,
        );
        if (result.success) {
          // Ensure message forwarding is set up for this channel
          ensureChannelForwarding(channel);
        }
        res.writeHead(result.success ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Kick an agent
  if (url.pathname === "/api/agents/kick" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { channel, name } = JSON.parse(body);
        if (!channel || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "channel and name required" }));
          return;
        }
        const result = agentManager.kick(channel, name);
        res.writeHead(result.success ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // List agents
  if (url.pathname === "/api/agents" && req.method === "GET") {
    const channel = url.searchParams.get("channel") || undefined;
    const agents = agentManager.getAgents(channel).map((a) => ({
      name: a.handle.name,
      channel: a.handle.channel,
      engine: a.handle.engine,
      state: a.state,
      status: a.status,
      startedAt: a.startedAt,
      lastActivity: a.lastActivity,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agents));
    return;
  }

  // Delete agent workspace
  if (url.pathname === "/api/agents/workspace" && req.method === "DELETE") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { channel, name } = JSON.parse(body);
        if (!channel || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "channel and name required" }));
          return;
        }

        // Check if agent is currently running
        const runningAgent = agentManager.getAgent(channel, name);
        if (runningAgent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Cannot delete workspace of a running agent. Kick it first.",
            }),
          );
          return;
        }

        const slugify = (text: string) =>
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        const workspacePath = path.join(
          "/tmp/powpow",
          `${slugify(channel)}--${slugify(name)}`,
        );

        if (!fs.existsSync(workspacePath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Workspace not found" }));
          return;
        }

        // Recursively delete the workspace
        fs.rmSync(workspacePath, { recursive: true, force: true });
        console.error(`[powpow] Deleted workspace: ${workspacePath}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: `Deleted workspace for ${name}`,
          }),
        );
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // List agent workspaces (for showing inactive agents)
  if (url.pathname === "/api/agents/workspaces" && req.method === "GET") {
    const channel = url.searchParams.get("channel");
    const workspaceDir = "/tmp/powpow";
    const workspaces: { channel: string; name: string }[] = [];

    try {
      if (fs.existsSync(workspaceDir)) {
        const dirs = fs.readdirSync(workspaceDir);
        for (const dir of dirs) {
          const match = dir.match(/^(.+)--(.+)$/);
          if (match) {
            const [, wsChannel, wsName] = match;
            if (!channel || wsChannel === channel) {
              workspaces.push({ channel: wsChannel, name: wsName });
            }
          }
        }
      }
    } catch (e) {
      console.error("Error reading workspaces:", e);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(workspaces));
    return;
  }

  // Get single agent details
  if (
    url.pathname.match(/^\/api\/agents\/[^/]+\/[^/]+$/) &&
    req.method === "GET"
  ) {
    const parts = url.pathname.split("/");
    const channel = decodeURIComponent(parts[3]);
    const name = decodeURIComponent(parts[4]);
    const agent = agentManager.getAgent(channel, name);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: agent.handle.name,
        channel: agent.handle.channel,
        engine: agent.handle.engine,
        sessionId: agent.handle.sessionId,
        workdir: agent.provider.getWorkdir(agent.handle),
        state: agent.state,
        status: agent.status,
        startedAt: agent.startedAt,
        lastActivity: agent.lastActivity,
        error: agent.error,
      }),
    );
    return;
  }

  // Get agent output/activity log
  if (
    url.pathname.match(/^\/api\/agents\/[^/]+\/[^/]+\/output$/) &&
    req.method === "GET"
  ) {
    const parts = url.pathname.split("/");
    const channel = decodeURIComponent(parts[3]);
    const name = decodeURIComponent(parts[4]);
    const limit = parseInt(url.searchParams.get("limit") || "100");
    const output = agentManager.getAgentOutput(channel, name, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(output));
    return;
  }

  // Send message to agent
  if (
    url.pathname.match(/^\/api\/agents\/[^/]+\/[^/]+\/message$/) &&
    req.method === "POST"
  ) {
    const parts = url.pathname.split("/");
    const channel = decodeURIComponent(parts[3]);
    const name = decodeURIComponent(parts[4]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { content } = JSON.parse(body);
        if (!content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content required" }));
          return;
        }
        const success = agentManager.sendMessage(channel, name, content);
        res.writeHead(success ? 200 : 404, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ success }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // SSE stream for channel updates (used by wrapper and web client)
  if (
    url.pathname.match(/^\/api\/channels\/[^/]+\/stream$/) &&
    req.method === "GET"
  ) {
    const channelName = decodeURIComponent(url.pathname.split("/")[3]);
    const sender = url.searchParams.get("sender") || undefined;
    const sseId = `sse_${++sseConnectionCounter}_${channelName}`;
    sseConnections.add(sseId);
    console.error(`SSE stream opened: ${sseId}${sender ? ` (${sender})` : ""}`);

    // Ensure channel exists
    store.getOrCreateChannel(channelName);

    // Track participant if sender provided
    if (sender) {
      if (!activeParticipants.has(channelName)) {
        activeParticipants.set(channelName, new Map());
      }
      activeParticipants
        .get(channelName)!
        .set(sseId, { sender, connectedAt: Date.now() });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        console.error(`SSE write error (${sseId}):`, err);
      }
    };

    // Send initial messages
    sendEvent("messages", store.getMessages(channelName));

    // Keepalive ping every 30 seconds
    const keepalive = setInterval(() => {
      try {
        res.write(`:ping\n\n`);
      } catch {}
    }, 30000);

    // Subscribe to message updates
    const unsubscribeMessages = store.subscribeToMessages(channelName, () => {
      sendEvent("messages", store.getMessages(channelName));
    });

    // Subscribe to artifact events (artifact + artifact_version SSE events)
    const unsubscribeArtifacts = wireArtifactSSE(channelName, sendEvent);

    // Subscribe to agent events (agent_output + agent_state SSE events)
    const unsubscribeAgents = wireAgentSSE(channelName, sendEvent);

    req.on("close", () => {
      sseConnections.delete(sseId);
      // Remove from active participants
      if (sender && activeParticipants.has(channelName)) {
        activeParticipants.get(channelName)!.delete(sseId);
        if (activeParticipants.get(channelName)!.size === 0) {
          activeParticipants.delete(channelName);
        }
      }
      console.error(`SSE stream closed: ${sseId}`);
      clearInterval(keepalive);
      unsubscribeMessages();
      unsubscribeArtifacts();
      unsubscribeAgents();
    });

    return;
  }

  // OAuth API - token management for HTTP MCPs

  // Helper to derive base URL from request Host header
  function getBaseUrlFromRequest(req: http.IncomingMessage): string {
    const host = req.headers.host || `${HOST}:${PORT}`;
    // Use https if X-Forwarded-Proto indicates it, otherwise http
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return `${proto}://${host}`;
  }

  // Helper to generate a deterministic client ID from origin
  // Format: cast-<first 8 chars of sha256 hash of origin>
  function generateClientIdFromOrigin(origin: string): string {
    const hash = crypto.createHash("sha256").update(origin).digest("hex");
    return `cast-${hash.substring(0, 8)}`;
  }

  const oauthDeps: OAuthApiDependencies = {
    getMcpArtifact: (channel: string, slug: string) => {
      const artifact = store.getArtifactWithFallback(channel, slug);
      if (!artifact || artifact.type !== "system.mcp") return null;
      return { props: artifact.props as { url?: string; auth?: OAuthConfig } };
    },
    getStoredTokens: (channel: string, mcpSlug: string) => {
      const status = getTokenStatus(channel, mcpSlug);
      if (status.status === "disconnected") return null;
      // Return minimal info needed for status check
      return {
        accessToken: "stored", // Actual token not needed for status
        expiresAt: status.expiresAt,
        scopes: status.scopes,
      };
    },
    storeTokens: (channel, mcpSlug, tokens, clientId) => {
      // Get MCP URL from artifact
      const artifact = store.getArtifactWithFallback(channel, mcpSlug);
      const mcpUrl = (artifact?.props as { url?: string })?.url || "";
      saveToken(channel, mcpSlug, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        tokenType: "Bearer",
      }, mcpUrl, clientId);
    },
    clearTokens: deleteToken,
    exchangeCodeForTokens: async (tokenEndpoint, code, codeVerifier, redirectUri, clientId, clientSecret, authMethod) => {
      const result = await exchangeCodeForTokens(tokenEndpoint, code, codeVerifier, redirectUri, clientId, clientSecret, authMethod);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresAt ? Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000) : undefined,
        scope: result.scopes?.join(" "),
      };
    },
    getBaseUrl: getBaseUrlFromRequest,
    generateClientId: generateClientIdFromOrigin,
  };

  if (url.pathname.startsWith("/api/oauth/")) {
    const handled = await handleOAuthRequest(req, res, url, oauthDeps);
    if (handled) return;
  }

  // Settings API - Backends

  // GET /api/backends - list all available backends/engines with capabilities
  if (url.pathname === "/api/backends" && req.method === "GET") {
    const enginesWithCaps = agentManager.getEnginesWithCapabilities();
    const backends = enginesWithCaps.map(({ engine, capabilities }) => ({
      name: engine,
      isBuiltIn: ["claude", "codex"].includes(engine),
      capabilities,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(backends));
    return;
  }

  // Raw artifact content endpoint for SPAs: GET /boards/:channel/:slug
  if (handleBoardsRequest(req, res, url)) {
    return;
  }

  // File upload endpoint: POST /api/channels/:channel/upload
  if (handleUploadRequest(req, res, url)) {
    return;
  }

  // Artifact REST endpoints (delegated to artifact-api.ts)
  // Handles: GET/POST /artifacts, GET/PUT/DELETE /artifacts/:slug, GET/POST /artifacts/:slug/versions, GET /artifacts/:slug/versions/:version
  if (handleArtifactRequest(req, res, url)) {
    return;
  }

  // Serve static files from web dist (for production/npx mode)
  // In dev mode, use `npm run dev` in packages/web instead (vite with HMR)
  const webDistDir = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "web",
    "dist",
  );
  if (fs.existsSync(webDistDir)) {
    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    let filePath = path.join(webDistDir, url.pathname);

    // Default to index.html for SPA routing (non-file paths)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(webDistDir, "index.html");
    }

    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
      return;
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Async startup to initialize provider registry
async function startServer() {
  // Resolve defaults directory relative to package installation, not cwd
  const defaultsDir = path.join(__dirname, "..", "..", "defaults");

  // Initialize agent manager with provider registry (includes external backends from defaults)
  agentManager = await AgentManager.create({
    defaultsDir: fs.existsSync(defaultsDir) ? defaultsDir : undefined,
    onStateChange: (agent: ManagedAgent) => {
      console.error(
        `[agent-manager] ${agent.handle.name} state: ${agent.state}${agent.status ? ` (${agent.status})` : ""}`,
      );
      // Emit SSE event for agent state changes
      emitAgentsChanged(agent.handle.channel, agent.handle.name);
    },
  });

  // Seed defaults if database is empty
  if (fs.existsSync(defaultsDir)) {
    seedDefaults(defaultsDir);
  }

  // Ensure #root channel exists (hidden system channel for playbooks/agents)
  store.ensureRootChannel();

  // Seed #root with system.agent artifacts from hat files
  if (fs.existsSync(defaultsDir)) {
    seedRootArtifacts(defaultsDir);
  }

  // Ensure custodian is in #root roster (after seeding artifacts)
  store.ensureRootCustodian();

  // Legacy migration hook (actual migration happens in store.ts DB initialization)
  migrateChannelAgentsToSlugs();

  // Initialize embedding service for semantic search
  initEmbeddings();

  httpServer.listen(PORT, HOST, () => {
    const bindAddr = HOST === "0.0.0.0" ? "all interfaces" : HOST;
    console.error(`Cast server running on http://${HOST}:${PORT} (${bindAddr})`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp (Streamable HTTP)`);
    console.error(`REST API: http://localhost:${PORT}/api/...`);
  });
}

startServer().catch((err) => {
  console.error("[powpow] Failed to start server:", err);
  process.exit(1);
});
