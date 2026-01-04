#!/usr/bin/env node
/**
 * Mock HTTP MCP Server
 *
 * HTTP-based MCP server for smoke testing the reactive agent engine.
 * Provides simple REST endpoints that match MCP protocol over HTTP.
 *
 * Endpoints:
 *   GET  /               - Server info
 *   POST /tools/list     - List available tools
 *   POST /tools/call     - Execute a tool
 *
 * Usage:
 *   npx tsx packages/test-harness/src/mock-http-mcp-server.ts [--port 4100]
 *
 * Configure in agent:
 *   mcpServers: [{
 *     name: "echo",
 *     transport: "http",
 *     url: "http://localhost:4100"
 *   }]
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

// =============================================================================
// Configuration
// =============================================================================

const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return defaultValue;
}

const PORT = parseInt(getArg("port", "4100"), 10);

// =============================================================================
// Tool Definitions
// =============================================================================

const TOOLS = [
  {
    name: "echo",
    description: "Returns the input message back to you. Use this to test MCP tool execution.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to echo back",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers together.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
];

// =============================================================================
// Tool Handlers
// =============================================================================

function handleToolCall(
  name: string,
  args: Record<string, unknown>
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case "echo": {
      const message = (args.message as string) ?? "";
      return {
        content: [{ type: "text", text: `Echo: ${message}` }],
      };
    }
    case "add": {
      const a = Number(args.a) || 0;
      const b = Number(args.b) || 0;
      return {
        content: [{ type: "text", text: `Result: ${a + b}` }],
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// =============================================================================
// HTTP Server
// =============================================================================

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Server info
  if (path === "/" && method === "GET") {
    sendJson(res, 200, {
      name: "mock-http-mcp",
      version: "1.0.0",
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    });
    return;
  }

  // List tools
  if (path === "/tools/list" && method === "POST") {
    sendJson(res, 200, { tools: TOOLS });
    return;
  }

  // Call tool
  if (path === "/tools/call" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { name, arguments: args } = body as {
        name?: string;
        arguments?: Record<string, unknown>;
      };

      if (!name) {
        sendJson(res, 400, { error: "Missing required field: name" });
        return;
      }

      const result = handleToolCall(name, args ?? {});
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found", path });
}

// =============================================================================
// Start Server
// =============================================================================

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () => {
  console.log(`Mock HTTP MCP server running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /            - Server info`);
  console.log(`  POST /tools/list  - List available tools`);
  console.log(`  POST /tools/call  - Execute a tool`);
  console.log(`\nTools: ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log(`\nExample:`);
  console.log(`  curl http://localhost:${PORT}/`);
  console.log(`  curl -X POST http://localhost:${PORT}/tools/list`);
  console.log(
    `  curl -X POST http://localhost:${PORT}/tools/call -H "Content-Type: application/json" -d '{"name":"echo","arguments":{"message":"Hello!"}}'`
  );
  console.log(`\nPress Ctrl+C to stop.\n`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
