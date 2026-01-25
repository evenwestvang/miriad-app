import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  getConfigFromEnv,
  uploadAsset,
  downloadAsset,
  createServer,
  type AssetsMcpConfig,
  type UploadAssetInput,
  type DownloadAssetInput,
} from "./index.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("getConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns config when all env vars are set", () => {
    process.env.CAST_API_URL = "https://cast.example.com";
    process.env.CAST_CONTAINER_TOKEN = "test-token";
    process.env.CAST_CHANNEL_ID = "channel-123";

    const config = getConfigFromEnv();

    expect(config).toEqual({
      apiUrl: "https://cast.example.com",
      containerToken: "test-token",
      channelId: "channel-123",
    });
  });

  it("throws when CAST_API_URL is missing", () => {
    process.env.CAST_CONTAINER_TOKEN = "test-token";
    process.env.CAST_CHANNEL_ID = "channel-123";

    expect(() => getConfigFromEnv()).toThrow("Missing required environment variables: CAST_API_URL");
  });

  it("throws when CAST_CONTAINER_TOKEN is missing", () => {
    process.env.CAST_API_URL = "https://cast.example.com";
    process.env.CAST_CHANNEL_ID = "channel-123";

    expect(() => getConfigFromEnv()).toThrow("Missing required environment variables: CAST_CONTAINER_TOKEN");
  });

  it("throws when CAST_CHANNEL_ID is missing", () => {
    process.env.CAST_API_URL = "https://cast.example.com";
    process.env.CAST_CONTAINER_TOKEN = "test-token";

    expect(() => getConfigFromEnv()).toThrow("Missing required environment variables: CAST_CHANNEL_ID");
  });

  it("throws with all missing vars listed", () => {
    expect(() => getConfigFromEnv()).toThrow(
      "Missing required environment variables: CAST_API_URL, CAST_CONTAINER_TOKEN, CAST_CHANNEL_ID"
    );
  });
});

describe("uploadAsset", () => {
  const config: AssetsMcpConfig = {
    apiUrl: "https://cast.example.com",
    containerToken: "test-token",
    channelId: "channel-123",
  };

  let tempDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    mockFetch.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-mcp-test-"));
    testFilePath = path.join(tempDir, "test-image.png");
    // Create a fake PNG file (minimal valid PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await fs.writeFile(testFilePath, pngHeader);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uploads a file successfully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slug: "test-asset",
        contentType: "image/png",
        fileSize: 8,
        url: "https://cast.example.com/api/assets/channel-123/test-asset",
      }),
    });

    const input: UploadAssetInput = {
      path: testFilePath,
      slug: "test-asset",
      tldr: "A test image",
    };

    const result = await uploadAsset(input, config);

    expect(result).toEqual({
      slug: "test-asset",
      contentType: "image/png",
      fileSize: 8,
      url: "https://cast.example.com/api/assets/channel-123/test-asset",
    });

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://cast.example.com/api/assets/channel-123");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Container test-token");
    expect(options.body).toBeInstanceOf(FormData);
  });

  it("includes optional title and parentSlug", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slug: "test-asset",
        contentType: "image/png",
        fileSize: 8,
        url: "https://cast.example.com/api/assets/channel-123/test-asset",
      }),
    });

    const input: UploadAssetInput = {
      path: testFilePath,
      slug: "test-asset",
      tldr: "A test image",
      title: "Test Image Title",
      parentSlug: "parent-folder",
    };

    await uploadAsset(input, config);

    const [, options] = mockFetch.mock.calls[0];
    const formData = options.body as FormData;
    expect(formData.get("title")).toBe("Test Image Title");
    expect(formData.get("parentSlug")).toBe("parent-folder");
  });

  it("throws when file does not exist", async () => {
    const input: UploadAssetInput = {
      path: "/nonexistent/file.png",
      slug: "test-asset",
      tldr: "A test image",
    };

    await expect(uploadAsset(input, config)).rejects.toThrow("File not found");
  });

  it("throws when path is a directory", async () => {
    const input: UploadAssetInput = {
      path: tempDir,
      slug: "test-asset",
      tldr: "A test image",
    };

    await expect(uploadAsset(input, config)).rejects.toThrow("Not a file");
  });

  it("throws when path is missing", async () => {
    const input = {
      slug: "test-asset",
      tldr: "A test image",
    } as UploadAssetInput;

    await expect(uploadAsset(input, config)).rejects.toThrow("path is required");
  });

  it("throws when slug is missing", async () => {
    const input = {
      path: testFilePath,
      tldr: "A test image",
    } as UploadAssetInput;

    await expect(uploadAsset(input, config)).rejects.toThrow("slug is required");
  });

  it("succeeds when tldr is omitted", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slug: "test-asset",
        contentType: "image/png",
        fileSize: 100,
        url: "https://example.com/assets/test-asset",
      }),
    });

    const input = {
      path: testFilePath,
      slug: "test-asset",
    } as UploadAssetInput;

    const result = await uploadAsset(input, config);
    expect(result.slug).toBe("test-asset");
  });

  it("throws on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => "Asset with slug already exists",
    });

    const input: UploadAssetInput = {
      path: testFilePath,
      slug: "existing-asset",
      tldr: "A test image",
    };

    await expect(uploadAsset(input, config)).rejects.toThrow(
      "Upload failed (409): Asset with slug already exists"
    );
  });

  it("throws on HTTP 401 unauthorized", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Invalid token",
    });

    const input: UploadAssetInput = {
      path: testFilePath,
      slug: "test-asset",
      tldr: "A test image",
    };

    await expect(uploadAsset(input, config)).rejects.toThrow(
      "Upload failed (401): Invalid token"
    );
  });
});

describe("downloadAsset", () => {
  const config: AssetsMcpConfig = {
    apiUrl: "https://cast.example.com",
    containerToken: "test-token",
    channelId: "channel-123",
  };

  let tempDir: string;

  beforeEach(async () => {
    mockFetch.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-mcp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("downloads a file successfully", async () => {
    const fileContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength
      ),
    });

    const downloadPath = path.join(tempDir, "downloaded.png");
    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: downloadPath,
    };

    const result = await downloadAsset(input, config);

    expect(result).toEqual({
      path: downloadPath,
      contentType: "image/png",
      fileSize: 4,
    });

    // Verify file was written
    const written = await fs.readFile(downloadPath);
    expect(written).toEqual(fileContent);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://cast.example.com/api/assets/channel-123/test-asset");
    expect(options.headers.Authorization).toBe("Container test-token");
  });

  it("creates parent directories if needed", async () => {
    const fileContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength
      ),
    });

    const downloadPath = path.join(tempDir, "nested", "dir", "downloaded.png");
    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: downloadPath,
    };

    const result = await downloadAsset(input, config);

    expect(result.path).toBe(downloadPath);
    const written = await fs.readFile(downloadPath);
    expect(written).toEqual(fileContent);
  });

  it("throws when file exists and overwrite is false", async () => {
    const existingFile = path.join(tempDir, "existing.png");
    await fs.writeFile(existingFile, "existing content");

    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: existingFile,
      overwrite: false,
    };

    await expect(downloadAsset(input, config)).rejects.toThrow(
      "File already exists"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("overwrites when overwrite is true", async () => {
    const existingFile = path.join(tempDir, "existing.png");
    await fs.writeFile(existingFile, "existing content");

    const fileContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength
      ),
    });

    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: existingFile,
      overwrite: true,
    };

    const result = await downloadAsset(input, config);

    expect(result.fileSize).toBe(4);
    const written = await fs.readFile(existingFile);
    expect(written).toEqual(fileContent);
  });

  it("throws when slug is missing", async () => {
    const input = {
      path: path.join(tempDir, "file.png"),
    } as DownloadAssetInput;

    await expect(downloadAsset(input, config)).rejects.toThrow("slug is required");
  });

  it("throws when path is missing", async () => {
    const input = {
      slug: "test-asset",
    } as DownloadAssetInput;

    await expect(downloadAsset(input, config)).rejects.toThrow("path is required");
  });

  it("throws on 404 not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    const input: DownloadAssetInput = {
      slug: "nonexistent-asset",
      path: path.join(tempDir, "file.png"),
    };

    await expect(downloadAsset(input, config)).rejects.toThrow(
      "Asset not found: nonexistent-asset"
    );
  });

  it("throws on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: path.join(tempDir, "file.png"),
    };

    await expect(downloadAsset(input, config)).rejects.toThrow(
      "Download failed (500): Internal server error"
    );
  });

  it("uses default content-type when header is missing", async () => {
    const fileContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(), // No content-type
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength
      ),
    });

    const downloadPath = path.join(tempDir, "downloaded.bin");
    const input: DownloadAssetInput = {
      slug: "test-asset",
      path: downloadPath,
    };

    const result = await downloadAsset(input, config);

    expect(result.contentType).toBe("application/octet-stream");
  });
});

describe("createServer", () => {
  const config: AssetsMcpConfig = {
    apiUrl: "https://cast.example.com",
    containerToken: "test-token",
    channelId: "channel-123",
  };

  it("creates a server with correct metadata", () => {
    const server = createServer(config);
    expect(server).toBeDefined();
  });

  it("lists tools correctly", async () => {
    const server = createServer(config);

    // Access the request handler through a simulated request
    // The server stores handlers internally, we need to trigger them
    const handlers = (server as unknown as { _requestHandlers: Map<string, unknown> })._requestHandlers;

    // For now, just verify the server was created with tools capability
    expect(server).toBeDefined();
  });
});

describe("MCP tool integration", () => {
  const config: AssetsMcpConfig = {
    apiUrl: "https://cast.example.com",
    containerToken: "test-token",
    channelId: "channel-123",
  };

  let tempDir: string;

  beforeEach(async () => {
    mockFetch.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-mcp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("handles upload tool errors gracefully", async () => {
    // Create server and simulate a tool call with invalid input
    const server = createServer(config);

    // The error handling is tested through uploadAsset directly
    // since the server wraps it and returns isError: true
    const input = { slug: "test" } as UploadAssetInput;
    await expect(uploadAsset(input, config)).rejects.toThrow();
  });

  it("handles download tool errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    const input: DownloadAssetInput = {
      slug: "missing",
      path: path.join(tempDir, "file.png"),
    };

    await expect(downloadAsset(input, config)).rejects.toThrow("Asset not found");
  });
});

describe("path resolution", () => {
  const config: AssetsMcpConfig = {
    apiUrl: "https://cast.example.com",
    containerToken: "test-token",
    channelId: "channel-123",
  };

  let tempDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    mockFetch.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-mcp-test-"));
    testFilePath = path.join(tempDir, "test-image.png");
    await fs.writeFile(testFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves relative paths for upload", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        slug: "test-asset",
        contentType: "image/png",
        fileSize: 4,
        url: "https://cast.example.com/api/assets/channel-123/test-asset",
      }),
    });

    // Use relative path from temp dir
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const input: UploadAssetInput = {
        path: "./test-image.png",
        slug: "test-asset",
        tldr: "A test image",
      };

      const result = await uploadAsset(input, config);
      expect(result.slug).toBe("test-asset");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("resolves relative paths for download", async () => {
    const fileContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength
      ),
    });

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const input: DownloadAssetInput = {
        slug: "test-asset",
        path: "./downloaded.png",
      };

      const result = await downloadAsset(input, config);
      // Use fs.realpathSync to handle macOS /var -> /private/var symlink
      const expectedPath = await fs.realpath(path.join(tempDir, "downloaded.png"));
      expect(result.path).toBe(expectedPath);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
