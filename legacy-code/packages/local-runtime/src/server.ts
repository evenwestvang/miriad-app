import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import type { ProcessDefinition } from "@cikada/agent";
import { createDriver } from "./driver.js";
import { storage } from "./storage.js";
import { tymbal, parseFrame, generateMessageId } from "@cikada/core/tymbal";
import { DockerOrchestrator } from "./sandbox/index.js";
import type {
  ArtifactStorage,
  ArtifactFilters,
  CreateArtifactRequest,
  CASChange,
} from "./artifact.js";

// =============================================================================
// Types
// =============================================================================

export interface ServerOptions {
  agents: Record<string, ProcessDefinition>;
  port?: number;
  anthropicApiKey?: string;
  artifactStorage?: ArtifactStorage;
  /** Enable Docker sandbox for claude-code agent type */
  enableSandbox?: boolean;
}

export interface CicadaServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

// =============================================================================
// Connection Management
// =============================================================================

interface Connection {
  ws: WebSocket;
  threadId: string;
}

// =============================================================================
// Server Implementation
// =============================================================================

export function createServer(options: ServerOptions): CicadaServer {
  const { agents, port = 3001, artifactStorage, enableSandbox = false } = options;

  // Initialize Anthropic client
  const apiKeyValue = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKeyValue) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it in environment or pass anthropicApiKey option."
    );
  }
  const apiKey: string = apiKeyValue; // Type narrowed
  const anthropic = new Anthropic({ apiKey });

  // Create driver
  const driver = createDriver({ anthropic });

  // Track connections by thread
  const connectionsByThread: Map<string, Set<Connection>> = new Map();

  // Docker orchestrator for sandbox agents (lazy initialized)
  let dockerOrchestrator: DockerOrchestrator | null = null;

  function getDockerOrchestrator(): DockerOrchestrator {
    if (!dockerOrchestrator) {
      dockerOrchestrator = new DockerOrchestrator({
        anthropicApiKey: apiKey,
        cikadaApiUrl: `http://localhost:${port}`,
        broadcast: async (threadId, frame) => {
          await broadcast(threadId, frame);
        },
      });
    }
    return dockerOrchestrator;
  }

  // Create HTTP server
  const httpServer = createHttpServer(handleHttpRequest);

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer });

  // ---------------------------------------------------------------------------
  // WebSocket Handling
  // ---------------------------------------------------------------------------

  wss.on("connection", (ws, req) => {
    // Extract thread ID from query param (AWS-compatible) or path (local convenience)
    // Primary: /?threadId=xxx (matches AWS API Gateway WebSocket)
    // Fallback: /thread/:threadId (easier for local testing)
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // Try query param first (AWS pattern)
    let threadId = url.searchParams.get("threadId");

    // Fallback to path pattern
    if (!threadId && pathParts[0] === "thread" && pathParts[1]) {
      threadId = pathParts[1];
    }

    if (!threadId) {
      ws.close(4000, "Missing threadId. Use ?threadId=xxx or /thread/:threadId");
      return;
    }
    const connection: Connection = { ws, threadId };

    // Add to connection set
    let connections = connectionsByThread.get(threadId);
    if (!connections) {
      connections = new Set();
      connectionsByThread.set(threadId, connections);
    }
    connections.add(connection);

    console.log(`[WS] Client connected to thread ${threadId}`);

    // Handle incoming messages
    ws.on("message", async (data) => {
      try {
        const message = data.toString();
        const frame = parseFrame(message);

        if (!frame) {
          console.warn("[WS] Invalid frame:", message);
          return;
        }

        // Handle sync request
        if ("request" in frame && frame.request === "sync") {
          await handleSync(ws, threadId, frame.since);
        }
      } catch (err) {
        console.error("[WS] Error handling message:", err);
      }
    });

    // Handle disconnect
    ws.on("close", () => {
      connections?.delete(connection);
      if (connections?.size === 0) {
        connectionsByThread.delete(threadId);
      }
      console.log(`[WS] Client disconnected from thread ${threadId}`);
    });

    ws.on("error", (err) => {
      console.error("[WS] Error:", err);
    });
  });

  // ---------------------------------------------------------------------------
  // Sync Handler
  // ---------------------------------------------------------------------------

  async function handleSync(
    ws: WebSocket,
    threadId: string,
    since?: string
  ): Promise<void> {
    const messages = await storage.getMessages(threadId, since);

    for (const msg of messages) {
      if (msg.isComplete) {
        ws.send(tymbal.set(msg.id, msg.value) + "\n");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Broadcast to Thread
  // ---------------------------------------------------------------------------

  async function broadcast(threadId: string, frame: string): Promise<void> {
    const connections = connectionsByThread.get(threadId);
    if (!connections) return;

    const frameWithNewline = frame.endsWith("\n") ? frame : frame + "\n";

    for (const conn of connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(frameWithNewline);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP Request Handling
  // ---------------------------------------------------------------------------

  async function handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathParts = url.pathname.split("/").filter(Boolean);

    try {
      // POST /thread/:threadId/message - Send a message
      if (
        req.method === "POST" &&
        pathParts[0] === "thread" &&
        pathParts[2] === "message"
      ) {
        const threadId = pathParts[1];
        const body = await readBody(req);
        const { content, agentName } = JSON.parse(body);

        if (!content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content is required" }));
          return;
        }

        // Get or create thread
        let thread = await storage.getThread(threadId);
        if (!thread) {
          const agent = agentName ?? Object.keys(agents)[0];
          // Allow claude-code even if not in agents map (it's a sandbox agent)
          if (!agents[agent] && agent !== "claude-code") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown agent: ${agent}` }));
            return;
          }
          thread = await storage.createThread(threadId, agent);
        }

        // Handle sandbox agents (claude-code)
        if (thread.agentName === "claude-code" && enableSandbox) {
          // Create and persist user message
          const messageId = generateMessageId();
          const messageValue = { type: "user", content };

          await storage.saveMessage({
            id: messageId,
            threadId,
            value: messageValue,
            timestamp: new Date().toISOString(),
            isComplete: true,
          });

          // Broadcast to connected clients
          await broadcast(threadId, tymbal.set(messageId, messageValue));

          // Return 200 immediately
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, threadId, messageId }));

          // Route to Docker orchestrator asynchronously
          getDockerOrchestrator()
            .sendMessage(threadId, content)
            .catch((err) => {
              console.error("[DockerOrchestrator] Error:", err);
            });

          return;
        }

        const agent = agents[thread.agentName];
        if (!agent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: `Unknown agent: ${thread.agentName}` })
          );
          return;
        }

        // Create and persist user message BEFORE returning 200
        // This ensures: 200 = message accepted and stored, non-200 = nothing persisted
        const messageId = generateMessageId();
        const messageValue = { type: "user", content };

        await storage.saveMessage({
          id: messageId,
          threadId,
          value: messageValue,
          timestamp: new Date().toISOString(),
          isComplete: true,
        });

        // Broadcast to connected clients
        await broadcast(threadId, tymbal.set(messageId, messageValue));

        // Now we can return 200 - message is safely stored
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, threadId, messageId }));

        // Run agent asynchronously (message already saved)
        driver
          .run({
            threadId,
            agentName: thread.agentName,
            userMessage: content,
            agent,
            broadcast: (frame) => broadcast(threadId, frame),
          })
          .catch((err) => {
            console.error("[Driver] Error:", err);
          });

        return;
      }

      // POST /thread/:threadId/tymbal - Receive Tymbal frames from sandbox containers
      if (
        req.method === "POST" &&
        pathParts[0] === "thread" &&
        pathParts[2] === "tymbal"
      ) {
        const threadId = pathParts[1];
        const body = await readBody(req);

        // Parse and broadcast the frame
        const frame = parseFrame(body);
        if (frame) {
          await broadcast(threadId, body);

          // Also persist the message if it's a complete set frame
          if ("v" in frame && frame.v && typeof frame.v === "object") {
            await storage.saveMessage({
              id: frame.i,
              threadId,
              value: frame.v as Record<string, unknown>,
              timestamp: (frame as { t?: string }).t ?? new Date().toISOString(),
              isComplete: true,
            });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // POST /thread - Create a new thread
      if (req.method === "POST" && pathParts[0] === "thread" && !pathParts[1]) {
        const body = await readBody(req);
        const { agentName } = body ? JSON.parse(body) : {};

        const agent = agentName ?? Object.keys(agents)[0];
        // Allow claude-code when sandbox is enabled
        if (!agents[agent] && !(agent === "claude-code" && enableSandbox)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown agent: ${agent}` }));
          return;
        }

        const threadId = generateMessageId();
        await storage.createThread(threadId, agent);

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ threadId, agentName: agent }));
        return;
      }

      // GET /thread/:threadId - Get thread info
      if (req.method === "GET" && pathParts[0] === "thread" && pathParts[1]) {
        const threadId = pathParts[1];
        const thread = await storage.getThread(threadId);

        if (!thread) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Thread not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(thread));
        return;
      }

      // GET /agents - List available agents
      if (req.method === "GET" && pathParts[0] === "agents") {
        const agentList = Object.entries(agents).map(([name, def]) => ({
          name,
          description: def.system.slice(0, 100),
        }));

        // Add claude-code when sandbox is enabled
        if (enableSandbox) {
          agentList.push({
            name: "claude-code",
            description: "Claude Code sandbox - runs Claude Code CLI in a Docker container",
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents: agentList }));
        return;
      }

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // =========================================================================
      // Artifact Routes - /channel/:channelId/artifacts/*
      // =========================================================================

      if (pathParts[0] === "channel" && pathParts[2] === "artifacts") {
        const channelId = pathParts[1];

        // Check if artifact storage is available
        if (!artifactStorage) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Artifact storage not configured" }));
          return;
        }

        // GET /channel/:id/artifacts/tree - Glob tree view
        if (req.method === "GET" && pathParts[3] === "tree") {
          const pattern = url.searchParams.get("pattern") ?? "/**";
          const tree = await artifactStorage.glob(channelId, pattern);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ tree }));
          return;
        }

        // GET /channel/:id/artifacts/:slug - Read artifact
        if (req.method === "GET" && pathParts[3]) {
          const slug = pathParts[3];
          const artifact = await artifactStorage.read(channelId, slug);

          if (!artifact) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Artifact not found" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ artifact }));
          return;
        }

        // GET /channel/:id/artifacts - List artifacts
        if (req.method === "GET") {
          const filters: ArtifactFilters = {};

          // Parse query params
          const typeParam = url.searchParams.get("type");
          if (typeParam) filters.type = typeParam as ArtifactFilters["type"];

          const statusParam = url.searchParams.get("status");
          if (statusParam) filters.status = statusParam as ArtifactFilters["status"];

          const assigneeParam = url.searchParams.get("assignee");
          if (assigneeParam) filters.assignee = assigneeParam;

          const parentSlugParam = url.searchParams.get("parentSlug");
          if (parentSlugParam) filters.parentSlug = parentSlugParam;

          const searchParam = url.searchParams.get("search");
          if (searchParam) filters.search = searchParam;

          const regexParam = url.searchParams.get("regex");
          if (regexParam) filters.regex = regexParam;

          const limitParam = url.searchParams.get("limit");
          if (limitParam) filters.limit = parseInt(limitParam, 10);

          const offsetParam = url.searchParams.get("offset");
          if (offsetParam) filters.offset = parseInt(offsetParam, 10);

          const artifacts = await artifactStorage.list(channelId, filters);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ artifacts }));
          return;
        }

        // POST /channel/:id/artifacts - Create artifact
        if (req.method === "POST" && !pathParts[3]) {
          const body = await readBody(req);
          const data: CreateArtifactRequest = JSON.parse(body);

          // Validate required fields
          if (!data.slug || !data.type || !data.tldr || !data.content || !data.sender) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Missing required fields: slug, type, tldr, content, sender",
            }));
            return;
          }

          // Validate slug format
          if (!/^[a-z0-9-]+(\.[a-z0-9]+)*$/.test(data.slug)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Invalid slug format. Use lowercase alphanumeric with hyphens (e.g., 'api-spec' or 'auth.test.ts')",
            }));
            return;
          }

          try {
            const artifact = await artifactStorage.create({
              slug: data.slug,
              channelId,
              type: data.type,
              title: data.title,
              tldr: data.tldr,
              content: data.content,
              parentSlug: data.parentSlug,
              status: data.status ?? "draft",
              assignees: data.assignees ?? [],
              labels: data.labels ?? [],
              createdBy: data.sender,
            });

            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ artifact }));
          } catch (err) {
            // Handle duplicate slug
            if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Artifact with slug '${data.slug}' already exists` }));
              return;
            }
            throw err;
          }
          return;
        }

        // PATCH /channel/:id/artifacts/:slug - Update artifact (CAS)
        if (req.method === "PATCH" && pathParts[3]) {
          const slug = pathParts[3];
          const body = await readBody(req);
          const { changes, sender }: { changes: CASChange[]; sender: string } = JSON.parse(body);

          if (!changes || !Array.isArray(changes) || !sender) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required fields: changes, sender" }));
            return;
          }

          const result = await artifactStorage.updateWithCAS(channelId, slug, changes, sender);

          if (!result.success) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ conflict: result.conflict }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ artifact: result.artifact }));
          return;
        }

        // DELETE /channel/:id/artifacts/:slug - Archive artifact (soft delete)
        if (req.method === "DELETE" && pathParts[3]) {
          const slug = pathParts[3];
          const body = await readBody(req);
          const { sender }: { sender: string } = body ? JSON.parse(body) : {};

          if (!sender) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required field: sender" }));
            return;
          }

          // Check artifact exists
          const existing = await artifactStorage.read(channelId, slug);
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Artifact not found" }));
            return;
          }

          await artifactStorage.archive(channelId, slug, sender);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          return;
        }
      }

      // Not found
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      console.error("[HTTP] Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal server error",
        })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Server Control
  // ---------------------------------------------------------------------------

  let actualPort = port;

  return {
    get port() {
      return actualPort;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            actualPort = addr.port;
          }
          console.log(`[Cicada] Server running at http://localhost:${actualPort}`);
          console.log(`[Cicada] WebSocket at ws://localhost:${actualPort}/thread/:threadId`);
          console.log(`[Cicada] Available agents: ${Object.keys(agents).join(", ")}`);
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        wss.close();
        httpServer.close(() => resolve());
      });
    },
  };
}
