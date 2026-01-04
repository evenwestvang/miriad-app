/**
 * Tests for MCP config converter
 */

import {
  convertToMcpServerConfig,
  buildMcpConfigFile,
  serializeMcpConfig,
} from "../converter.js";
import type { ResolvedMcpConfig, McpServerConfig } from "../types.js";

describe("convertToMcpServerConfig", () => {
  it("should convert stdio config", () => {
    const resolved: ResolvedMcpConfig = {
      slug: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "github-mcp"],
      env: { TOKEN: "secret" },
      cwd: "/tmp",
    };

    const result = convertToMcpServerConfig(resolved);

    expect(result).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "github-mcp"],
      env: { TOKEN: "secret" },
      cwd: "/tmp",
    });
  });

  it("should convert http config", () => {
    const resolved: ResolvedMcpConfig = {
      slug: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer token" },
    };

    const result = convertToMcpServerConfig(resolved);

    expect(result).toEqual({
      type: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("should handle minimal stdio config", () => {
    const resolved: ResolvedMcpConfig = {
      slug: "minimal",
      transport: "stdio",
      command: "my-mcp",
    };

    const result = convertToMcpServerConfig(resolved);

    expect(result).toEqual({
      type: "stdio",
      command: "my-mcp",
      args: undefined,
      env: undefined,
      cwd: undefined,
    });
  });

  it("should handle minimal http config", () => {
    const resolved: ResolvedMcpConfig = {
      slug: "minimal",
      transport: "http",
      url: "https://example.com",
    };

    const result = convertToMcpServerConfig(resolved);

    expect(result).toEqual({
      type: "http",
      url: "https://example.com",
      headers: undefined,
    });
  });
});

describe("buildMcpConfigFile", () => {
  it("should build config from resolved MCPs", () => {
    const resolved: ResolvedMcpConfig[] = [
      { slug: "mcp-a", transport: "stdio", command: "a" },
      { slug: "mcp-b", transport: "http", url: "https://b.com" },
    ];

    const result = buildMcpConfigFile(resolved);

    expect(result).toEqual({
      mcpServers: {
        "mcp-a": { type: "stdio", command: "a", args: undefined, env: undefined, cwd: undefined },
        "mcp-b": { type: "http", url: "https://b.com", headers: undefined },
      },
    });
  });

  it("should include built-in MCPs", () => {
    const builtIn: Record<string, McpServerConfig> = {
      "cikada-tools": { type: "http", url: "http://localhost:3000/mcp" },
    };

    const resolved: ResolvedMcpConfig[] = [
      { slug: "external", transport: "stdio", command: "ext" },
    ];

    const result = buildMcpConfigFile(resolved, builtIn);

    expect(result.mcpServers["cikada-tools"]).toEqual({
      type: "http",
      url: "http://localhost:3000/mcp",
    });
    expect(result.mcpServers["external"]).toBeDefined();
  });

  it("should handle empty resolved array", () => {
    const result = buildMcpConfigFile([]);
    expect(result).toEqual({ mcpServers: {} });
  });

  it("should handle empty with built-in only", () => {
    const builtIn: Record<string, McpServerConfig> = {
      "cikada-tools": { type: "http", url: "http://localhost/mcp" },
    };

    const result = buildMcpConfigFile([], builtIn);
    expect(result.mcpServers["cikada-tools"]).toBeDefined();
    expect(Object.keys(result.mcpServers)).toHaveLength(1);
  });
});

describe("serializeMcpConfig", () => {
  it("should serialize to pretty JSON", () => {
    const config = {
      mcpServers: {
        test: { type: "stdio" as const, command: "test" },
      },
    };

    const result = serializeMcpConfig(config);

    expect(result).toContain('"mcpServers"');
    expect(result).toContain('"test"');
    expect(result).toContain("\n"); // Pretty printed
  });

  it("should produce valid JSON", () => {
    const config = {
      mcpServers: {
        mcp: { type: "http" as const, url: "https://example.com" },
      },
    };

    const serialized = serializeMcpConfig(config);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(config);
  });
});
