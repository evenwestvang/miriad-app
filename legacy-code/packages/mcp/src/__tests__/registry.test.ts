/**
 * Tests for MCP registry and resolution
 */

import {
  getArtifactWithFallback,
  resolveMcpForAgent,
  resolveMcpConfigs,
  buildResolvedConfig,
} from "../registry.js";
import type { McpArtifact, McpStorage } from "../types.js";

// Mock storage implementation
function createMockStorage(
  artifacts: Record<string, Record<string, McpArtifact>>
): McpStorage {
  return {
    getArtifact(channel: string, slug: string): McpArtifact | null {
      return artifacts[channel]?.[slug] ?? null;
    },
  };
}

describe("getArtifactWithFallback", () => {
  it("should return artifact from channel if found", async () => {
    const storage = createMockStorage({
      "my-channel": {
        "my-mcp": { slug: "my-mcp", type: "system.mcp", props: {} },
      },
    });

    const result = await getArtifactWithFallback(storage, "my-channel", "my-mcp");
    expect(result).not.toBeNull();
    expect(result?.slug).toBe("my-mcp");
  });

  it("should fall back to root if not in channel", async () => {
    const storage = createMockStorage({
      root: {
        "global-mcp": { slug: "global-mcp", type: "system.mcp", props: {} },
      },
    });

    const result = await getArtifactWithFallback(storage, "my-channel", "global-mcp");
    expect(result).not.toBeNull();
    expect(result?.slug).toBe("global-mcp");
  });

  it("should prefer channel over root", async () => {
    const storage = createMockStorage({
      "my-channel": {
        "mcp": { slug: "mcp", type: "system.mcp", props: { transport: "stdio", command: "channel-cmd" } },
      },
      root: {
        "mcp": { slug: "mcp", type: "system.mcp", props: { transport: "stdio", command: "root-cmd" } },
      },
    });

    const result = await getArtifactWithFallback(storage, "my-channel", "mcp");
    expect(result?.props?.command).toBe("channel-cmd");
  });

  it("should return null if not found anywhere", async () => {
    const storage = createMockStorage({});
    const result = await getArtifactWithFallback(storage, "my-channel", "missing");
    expect(result).toBeNull();
  });
});

describe("resolveMcpForAgent", () => {
  it("should return system.mcp artifact", async () => {
    const storage = createMockStorage({
      root: {
        "my-mcp": { slug: "my-mcp", type: "system.mcp", props: {} },
      },
    });

    const result = await resolveMcpForAgent(storage, "any-channel", "my-mcp");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("system.mcp");
  });

  it("should return null for non-system.mcp artifact", async () => {
    const storage = createMockStorage({
      root: {
        "my-doc": { slug: "my-doc", type: "doc", props: {} },
      },
    });

    const result = await resolveMcpForAgent(storage, "any-channel", "my-doc");
    expect(result).toBeNull();
  });

  it("should return null if not found", async () => {
    const storage = createMockStorage({});
    const result = await resolveMcpForAgent(storage, "any-channel", "missing");
    expect(result).toBeNull();
  });
});

describe("buildResolvedConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should build stdio config", () => {
    const artifact: McpArtifact = {
      slug: "github-mcp",
      type: "system.mcp",
      props: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "token123" },
        cwd: "/tmp",
      },
    };

    const result = buildResolvedConfig(artifact);

    expect(result).toEqual({
      slug: "github-mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "token123" },
      cwd: "/tmp",
    });
  });

  it("should build http config", () => {
    const artifact: McpArtifact = {
      slug: "remote-mcp",
      type: "system.mcp",
      props: {
        transport: "http",
        url: "https://mcp.example.com",
        headers: { "X-Api-Key": "key123" },
      },
    };

    const result = buildResolvedConfig(artifact);

    expect(result).toEqual({
      slug: "remote-mcp",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { "X-Api-Key": "key123" },
    });
  });

  it("should resolve env vars in stdio config", () => {
    process.env.MY_TOKEN = "secret";

    const artifact: McpArtifact = {
      slug: "mcp",
      type: "system.mcp",
      props: {
        transport: "stdio",
        command: "npx",
        env: { TOKEN: "${MY_TOKEN}" },
      },
    };

    const result = buildResolvedConfig(artifact);
    expect(result.env?.TOKEN).toBe("secret");
  });

  it("should resolve env vars in http headers", () => {
    process.env.API_KEY = "abc123";

    const artifact: McpArtifact = {
      slug: "mcp",
      type: "system.mcp",
      props: {
        transport: "http",
        url: "https://example.com",
        headers: { Authorization: "Bearer ${API_KEY}" },
      },
    };

    const result = buildResolvedConfig(artifact);
    expect(result.headers?.Authorization).toBe("Bearer abc123");
  });
});

describe("resolveMcpConfigs", () => {
  it("should resolve multiple MCPs", async () => {
    const storage = createMockStorage({
      root: {
        "mcp-a": {
          slug: "mcp-a",
          type: "system.mcp",
          props: { transport: "stdio", command: "cmd-a" },
        },
        "mcp-b": {
          slug: "mcp-b",
          type: "system.mcp",
          props: { transport: "http", url: "https://b.com" },
        },
      },
    });

    const result = await resolveMcpConfigs(storage, "my-channel", [
      { slug: "mcp-a" },
      { slug: "mcp-b" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe("mcp-a");
    expect(result[1].slug).toBe("mcp-b");
  });

  it("should skip missing MCPs", async () => {
    const storage = createMockStorage({
      root: {
        "exists": {
          slug: "exists",
          type: "system.mcp",
          props: { transport: "stdio", command: "cmd" },
        },
      },
    });

    const result = await resolveMcpConfigs(storage, "my-channel", [
      { slug: "exists" },
      { slug: "missing" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("exists");
  });

  it("should return empty array for empty refs", async () => {
    const storage = createMockStorage({});
    const result = await resolveMcpConfigs(storage, "my-channel", []);
    expect(result).toEqual([]);
  });
});
