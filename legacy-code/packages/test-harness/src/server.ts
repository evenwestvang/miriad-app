/**
 * Test Harness HTTP Server
 *
 * Provides curl-able HTTP endpoints for testing reactive agents
 * without the full Cikada server stack.
 *
 * Endpoints:
 * - GET  /health          - Health check
 * - POST /message         - Send message to agent
 * - GET  /messages        - Get message history
 * - GET  /artifacts       - List artifacts
 * - GET  /artifacts/:slug - Get specific artifact
 * - POST /artifacts       - Create artifact
 * - GET  /state           - Inspect agent state
 * - POST /reset           - Reset all stores
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { MessageStore, ArtifactStore, AgentStateStore, type Message, type Artifact } from "./stores.js";

// =============================================================================
// Types
// =============================================================================

export interface HarnessConfig {
  port: number;
  channel: string;
  agentId: string;
  onMessage?: (message: Message) => Promise<void>;
}

interface RequestBody {
  [key: string]: unknown;
}

// =============================================================================
// Server Implementation
// =============================================================================

export class TestHarnessServer {
  private server: ReturnType<typeof createServer> | null = null;
  private config: HarnessConfig;

  readonly messages: MessageStore;
  readonly artifacts: ArtifactStore;
  readonly agentState: AgentStateStore;

  constructor(config: Partial<HarnessConfig> = {}) {
    this.config = {
      port: config.port ?? 4000,
      channel: config.channel ?? "test",
      agentId: config.agentId ?? "test-agent",
      onMessage: config.onMessage,
    };

    this.messages = new MessageStore();
    this.artifacts = new ArtifactStore();
    this.agentState = new AgentStateStore();

    // Initialize agent state
    this.agentState.set({
      agentId: this.config.agentId,
      channel: this.config.channel,
      status: "idle",
      checkpoints: new Map(),
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error("Request error:", err);
          this.sendJson(res, 500, { error: "Internal server error" });
        });
      });

      this.server.listen(this.config.port, () => {
        console.log(`Test harness running on http://localhost:${this.config.port}`);
        console.log(`Channel: ${this.config.channel}`);
        console.log(`Agent: ${this.config.agentId}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    // CORS headers for local testing
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (path === "/health" && method === "GET") {
      return this.handleHealth(res);
    }

    if (path === "/message" && method === "POST") {
      const body = await this.parseBody(req);
      return this.handleSendMessage(res, body);
    }

    if (path === "/messages" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      return this.handleGetMessages(res, limit);
    }

    if (path === "/artifacts" && method === "GET") {
      return this.handleListArtifacts(res, url.searchParams);
    }

    if (path === "/artifacts" && method === "POST") {
      const body = await this.parseBody(req);
      return this.handleCreateArtifact(res, body);
    }

    if (path.startsWith("/artifacts/") && method === "GET") {
      const slug = path.slice("/artifacts/".length);
      return this.handleGetArtifact(res, slug);
    }

    if (path === "/state" && method === "GET") {
      return this.handleGetState(res);
    }

    if (path === "/reset" && method === "POST") {
      return this.handleReset(res);
    }

    // 404
    this.sendJson(res, 404, { error: "Not found", path });
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private handleHealth(res: ServerResponse): void {
    this.sendJson(res, 200, {
      status: "ok",
      channel: this.config.channel,
      agentId: this.config.agentId,
      messageCount: this.messages.count(),
      artifactCount: this.artifacts.count(),
    });
  }

  private async handleSendMessage(res: ServerResponse, body: RequestBody): Promise<void> {
    const content = body.content as string;
    const sender = (body.sender as string) ?? "user";

    if (!content) {
      this.sendJson(res, 400, { error: "Missing required field: content" });
      return;
    }

    // Store the incoming message
    const message = this.messages.add({
      channel: this.config.channel,
      sender,
      content,
      type: "message",
    });

    // Update agent state
    this.agentState.setStatus(this.config.channel, this.config.agentId, "running");

    // If there's a message handler, invoke it
    if (this.config.onMessage) {
      try {
        await this.config.onMessage(message);
        this.agentState.setStatus(this.config.channel, this.config.agentId, "idle");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.agentState.setStatus(
          this.config.channel,
          this.config.agentId,
          "error",
          errorMessage
        );
      }
    } else {
      // No handler - just mark as idle
      this.agentState.setStatus(this.config.channel, this.config.agentId, "idle");
    }

    this.sendJson(res, 200, {
      message,
      agentStatus: this.agentState.get(this.config.channel, this.config.agentId)?.status,
    });
  }

  private handleGetMessages(res: ServerResponse, limit: number): void {
    const messages = this.messages.getRecent(this.config.channel, limit);
    this.sendJson(res, 200, { messages, count: messages.length });
  }

  private handleListArtifacts(res: ServerResponse, params: URLSearchParams): void {
    const query: Parameters<ArtifactStore["query"]>[0] = {
      channel: this.config.channel,
    };

    const type = params.get("type");
    if (type) {
      query.type = type as Artifact["type"];
    }

    const status = params.get("status");
    if (status) {
      query.status = status as Artifact["status"];
    }

    const assignee = params.get("assignee");
    if (assignee) {
      query.assignee = assignee;
    }

    const artifacts = this.artifacts.query(query);
    this.sendJson(res, 200, { artifacts, count: artifacts.length });
  }

  private handleGetArtifact(res: ServerResponse, slug: string): void {
    const artifact = this.artifacts.get(this.config.channel, slug);
    if (!artifact) {
      this.sendJson(res, 404, { error: "Artifact not found", slug });
      return;
    }
    this.sendJson(res, 200, { artifact });
  }

  private handleCreateArtifact(res: ServerResponse, body: RequestBody): void {
    const { slug, type, title, tldr, content, status, assignees, labels, createdBy } = body as {
      slug?: string;
      type?: string;
      title?: string;
      tldr?: string;
      content?: string;
      status?: string;
      assignees?: string[];
      labels?: string[];
      createdBy?: string;
    };

    if (!slug || !type || !tldr || !content) {
      this.sendJson(res, 400, {
        error: "Missing required fields: slug, type, tldr, content",
      });
      return;
    }

    try {
      const artifact = this.artifacts.create({
        slug,
        channel: this.config.channel,
        type: type as Artifact["type"],
        title,
        tldr,
        content,
        status: (status as Artifact["status"]) ?? "published",
        assignees: assignees ?? [],
        labels: labels ?? [],
        createdBy: createdBy ?? this.config.agentId,
      });
      this.sendJson(res, 201, { artifact });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 409, { error: message });
    }
  }

  private handleGetState(res: ServerResponse): void {
    const state = this.agentState.get(this.config.channel, this.config.agentId);
    if (!state) {
      this.sendJson(res, 404, { error: "Agent state not found" });
      return;
    }

    // Convert checkpoints Map to object for JSON
    const checkpoints: Record<string, unknown> = {};
    state.checkpoints.forEach((value, key) => {
      checkpoints[key] = value;
    });

    this.sendJson(res, 200, {
      agentId: state.agentId,
      channel: state.channel,
      status: state.status,
      lastMessageId: state.lastMessageId,
      checkpoints,
      error: state.error,
    });
  }

  private handleReset(res: ServerResponse): void {
    this.messages.clear();
    this.artifacts.clear();
    this.agentState.clear();

    // Re-initialize agent state
    this.agentState.set({
      agentId: this.config.agentId,
      channel: this.config.channel,
      status: "idle",
      checkpoints: new Map(),
    });

    this.sendJson(res, 200, { status: "reset complete" });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async parseBody(req: IncomingMessage): Promise<RequestBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(body.trim() ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error(`Invalid JSON body: ${err}`));
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createTestHarness(config?: Partial<HarnessConfig>): TestHarnessServer {
  return new TestHarnessServer(config);
}
