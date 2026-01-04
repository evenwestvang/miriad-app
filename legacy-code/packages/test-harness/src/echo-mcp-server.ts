#!/usr/bin/env node
/**
 * Echo MCP Server
 *
 * Minimal MCP server for smoke testing the reactive agent engine.
 * Provides a single "echo" tool that returns the input message.
 *
 * Usage:
 *   npx tsx packages/test-harness/src/echo-mcp-server.ts
 *
 * Configure in agent:
 *   mcpServers: [{
 *     name: "echo",
 *     transport: "stdio",
 *     command: "npx",
 *     args: ["tsx", "packages/test-harness/src/echo-mcp-server.ts"]
 *   }]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Handle tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

// Handle tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "echo") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const message = (args as { message?: string })?.message ?? "";
  return {
    content: [{ type: "text", text: `Echo: ${message}` }],
  };
});

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
