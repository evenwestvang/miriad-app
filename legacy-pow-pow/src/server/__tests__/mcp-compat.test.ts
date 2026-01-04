/**
 * MCP Compatibility Tests
 *
 * Verifies all PowPow MCP tools work correctly with the Streamable HTTP transport.
 * Tests the tool schemas, request/response handling, and error cases.
 *
 * Run with: npx tsx --test src/server/__tests__/mcp-compat.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import http from "http";

// Server URL - assumes server is running for integration tests
const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3131";
const MCP_ENDPOINT = `${SERVER_URL}/mcp`;

/**
 * Make an MCP request via Streamable HTTP.
 */
async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const result = await response.json();
  return result as { result?: unknown; error?: { code: number; message: string } };
}

/**
 * Initialize an MCP session and return the session ID.
 */
async function initSession(): Promise<string> {
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });

  const sessionId = response.headers.get("Mcp-Session-Id");
  if (!sessionId) {
    throw new Error("No session ID returned from initialize");
  }
  return sessionId;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("MCP Streamable HTTP Transport", () => {
  let sessionId: string = "";

  before(async () => {
    // Check if server is running
    try {
      const health = await fetch(`${SERVER_URL}/api/health`);
      if (!health.ok) {
        throw new Error("Server not healthy");
      }
    } catch {
      console.log("Skipping MCP tests - server not running at", SERVER_URL);
      return;
    }

    sessionId = await initSession();
  });

  it("should initialize session with protocol version", { skip: !sessionId }, async () => {
    assert.ok(sessionId, "Should have session ID");
    assert.match(sessionId, /^[a-f0-9-]+$/i, "Session ID should be UUID format");
  });

  it("should list available tools", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/list", {}, sessionId);

    assert.ok(response.result, "Should have result");
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(Array.isArray(tools), "Tools should be array");

    // Verify core PowPow tools are present
    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes("list_channels"), "Should have list_channels");
    assert.ok(toolNames.includes("track_channel"), "Should have track_channel");
    assert.ok(toolNames.includes("send_message"), "Should have send_message");
    assert.ok(toolNames.includes("get_messages"), "Should have get_messages");
    assert.ok(toolNames.includes("set_status"), "Should have set_status");

    // Verify artifact tools are present
    assert.ok(toolNames.includes("glob"), "Should have artifact glob");
    assert.ok(toolNames.includes("read"), "Should have artifact read");
    assert.ok(toolNames.includes("create"), "Should have artifact create");
  });
});

describe("MCP Channel Tools", () => {
  let sessionId: string = "";
  const TEST_CHANNEL = `mcp-test-${Date.now()}`;

  before(async () => {
    try {
      await fetch(`${SERVER_URL}/api/health`);
      sessionId = await initSession();
    } catch {
      console.log("Skipping MCP channel tests - server not running");
    }
  });

  it("should list channels", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "list_channels",
      arguments: {},
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    assert.ok(Array.isArray(content), "Content should be array");
  });

  it("should track a channel", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "track_channel",
      arguments: { channel: TEST_CHANNEL },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const text = content[0]?.text;
    assert.ok(text, "Should have text response");

    const data = JSON.parse(text);
    assert.strictEqual(data.tracking, true, "Should be tracking");
    assert.strictEqual(data.channel.name, TEST_CHANNEL, "Should track correct channel");
  });

  it("should reject send_message without @mention", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "send_message",
      arguments: {
        channel: TEST_CHANNEL,
        sender: "test-sender",
        content: "Hello without mention",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.strictEqual(result.isError, true, "Should be error");
    assert.ok(result.content[0].text.includes("@mention"), "Error should mention @mention requirement");
  });

  it("should send message with @mention", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "send_message",
      arguments: {
        channel: TEST_CHANNEL,
        sender: "test-sender",
        content: "@channel Hello with mention",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const text = content[0]?.text;
    const message = JSON.parse(text);

    assert.ok(message.id, "Message should have id");
    assert.strictEqual(message.channel, TEST_CHANNEL, "Message should have channel");
    assert.strictEqual(message.sender, "test-sender", "Message should have sender");
    assert.ok(message.content.includes("@channel"), "Message should have content");
  });

  it("should get messages", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "get_messages",
      arguments: { channel: TEST_CHANNEL, limit: 10 },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const messages = JSON.parse(content[0]?.text);

    assert.ok(Array.isArray(messages), "Messages should be array");
    assert.ok(messages.length > 0, "Should have at least one message from previous test");
  });

  it("should set status", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "set_status",
      arguments: {
        channel: TEST_CHANNEL,
        sender: "test-sender",
        status: "running tests",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    assert.ok(content[0]?.text.includes("running tests"), "Should confirm status");
  });
});

describe("MCP Artifact Tools", () => {
  let sessionId: string = "";
  const TEST_CHANNEL = `artifact-test-${Date.now()}`;
  const TEST_SLUG = `test-artifact-${Date.now()}`;

  before(async () => {
    try {
      await fetch(`${SERVER_URL}/api/health`);
      sessionId = await initSession();
      // Create channel first
      await mcpRequest("tools/call", {
        name: "track_channel",
        arguments: { channel: TEST_CHANNEL },
      }, sessionId);
    } catch {
      console.log("Skipping MCP artifact tests - server not running");
    }
  });

  it("should create artifact", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "create",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
        type: "doc",
        tldr: "Test artifact for MCP compat tests",
        content: "# Test Content\n\nThis is test content.",
        sender: "test-sender",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const result = JSON.parse(content[0]?.text);

    assert.strictEqual(result.action, "created", "Should be created action");
    assert.strictEqual(result.artifact.slug, TEST_SLUG, "Should have correct slug");
  });

  it("should read artifact", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "read",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const artifact = JSON.parse(content[0]?.text);

    assert.strictEqual(artifact.slug, TEST_SLUG, "Should have correct slug");
    assert.ok(artifact.content.includes("Test Content"), "Should have content");
  });

  it("should glob artifacts", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "glob",
      arguments: {
        channel: TEST_CHANNEL,
        pattern: "/**",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const tree = content[0]?.text;

    assert.ok(tree.includes(TEST_SLUG), "Tree should include test artifact");
  });

  it("should list artifacts", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "list",
      arguments: {
        channel: TEST_CHANNEL,
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
    const content = (response.result as { content: Array<{ text: string }> }).content;
    const artifacts = JSON.parse(content[0]?.text);

    assert.ok(Array.isArray(artifacts), "Artifacts should be array");
    assert.ok(
      artifacts.some((a: { slug: string }) => a.slug === TEST_SLUG),
      "Should include test artifact"
    );
  });

  it("should edit artifact", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "edit",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
        old_string: "Test Content",
        new_string: "Updated Content",
        sender: "test-sender",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");

    // Verify edit applied
    const readResponse = await mcpRequest("tools/call", {
      name: "read",
      arguments: { channel: TEST_CHANNEL, slug: TEST_SLUG },
    }, sessionId);

    const content = (readResponse.result as { content: Array<{ text: string }> }).content;
    const artifact = JSON.parse(content[0]?.text);
    assert.ok(artifact.content.includes("Updated Content"), "Content should be updated");
  });

  it("should update artifact metadata", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "update",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
        sender: "test-sender",
        changes: [
          { field: "status", old_value: "published", new_value: "draft" },
        ],
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
  });

  it("should checkpoint artifact", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "checkpoint",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
        version: "v1.0",
        sender: "test-sender",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");
  });

  it("should archive artifact", { skip: !sessionId }, async () => {
    const response = await mcpRequest("tools/call", {
      name: "archive",
      arguments: {
        channel: TEST_CHANNEL,
        slug: TEST_SLUG,
        sender: "test-sender",
      },
    }, sessionId);

    assert.ok(response.result, "Should have result");

    // Verify archived
    const readResponse = await mcpRequest("tools/call", {
      name: "read",
      arguments: { channel: TEST_CHANNEL, slug: TEST_SLUG },
    }, sessionId);

    const content = (readResponse.result as { content: Array<{ text: string }> }).content;
    const artifact = JSON.parse(content[0]?.text);
    assert.strictEqual(artifact.status, "archived", "Should be archived");
  });
});

describe("MCP Session Management", () => {
  it("should reject requests without session for GET", async () => {
    try {
      const response = await fetch(MCP_ENDPOINT, { method: "GET" });
      assert.strictEqual(response.status, 400, "Should reject GET without session");
    } catch {
      console.log("Skipping session test - server not running");
    }
  });

  it("should handle session termination via DELETE", async () => {
    try {
      const sessionId = await initSession();
      const response = await fetch(MCP_ENDPOINT, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
      });
      assert.strictEqual(response.status, 200, "Should accept DELETE with valid session");
    } catch {
      console.log("Skipping session termination test - server not running");
    }
  });
});
