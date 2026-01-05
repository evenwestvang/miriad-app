import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMcpRoutes } from './mcp-http.js';
import { generateContainerToken } from '../auth/container-token.js';
import type { Storage } from '@cast/storage';
import type { StoredMessage, StoredChannel } from '@cast/core';
import type { AssetStorage } from '../assets/index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_SPACE_ID = 'test-space';
const TEST_CHANNEL_ID = '01ABCDEFGH123456789012345'; // ULID-style ID
const TEST_CHANNEL_NAME = 'test-channel';
const TEST_CALLSIGN = 'test-agent';

const testChannel: StoredChannel = {
  id: TEST_CHANNEL_ID,
  spaceId: TEST_SPACE_ID,
  name: TEST_CHANNEL_NAME,
  tagline: 'Test workspace',
  mission: 'Testing MCP',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const testMessages: StoredMessage[] = [
  {
    id: 'msg-1',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'fox',
    senderType: 'agent',
    type: 'message',
    content: 'Hello from fox',
    timestamp: '2026-01-01T00:00:00Z',
    isComplete: true,
  },
  {
    id: 'msg-2',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'bear',
    senderType: 'agent',
    type: 'message',
    content: 'Hello from bear',
    timestamp: '2026-01-01T00:01:00Z',
    isComplete: true,
  },
  {
    id: 'msg-3',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'fox',
    senderType: 'agent',
    type: 'message',
    content: 'Testing search functionality',
    timestamp: '2026-01-01T00:02:00Z',
    isComplete: true,
  },
];

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(): Storage {
  return {
    // Channel operations
    getChannel: vi.fn(async (spaceId: string, channelId: string) => {
      if (channelId === TEST_CHANNEL_ID) return testChannel;
      return null;
    }),
    getChannelByName: vi.fn(async (spaceId: string, name: string) => {
      if (name === TEST_CHANNEL_NAME) return testChannel;
      return null;
    }),
    listChannels: vi.fn(async () => []),
    createChannel: vi.fn(async () => testChannel),
    updateChannel: vi.fn(async () => {}),
    archiveChannel: vi.fn(async () => {}),

    // Message operations
    getMessages: vi.fn(async (spaceId: string, channelId: string, params?: { limit?: number }) => {
      if (channelId === TEST_CHANNEL_ID) {
        const limit = params?.limit ?? 50;
        return testMessages.slice(0, limit);
      }
      return [];
    }),
    getMessage: vi.fn(async () => null),
    saveMessage: vi.fn(async () => testMessages[0]),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),

    // Roster operations
    addToRoster: vi.fn(async () => ({
      id: 'roster-1',
      channelId: TEST_CHANNEL_ID,
      callsign: TEST_CALLSIGN,
      agentType: 'engineer',
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    getRosterEntry: vi.fn(async () => null),
    getRosterByCallsign: vi.fn(async () => null),
    listRoster: vi.fn(async () => []),
    updateRosterEntry: vi.fn(async () => {}),
    removeFromRoster: vi.fn(async () => {}),

    // Artifact operations (Phase A)
    createArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      title: 'Test Artifact',
      tldr: 'Test summary',
      content: '# Test',
      path: 'test_artifact',
      orderKey: '0',
      status: 'draft' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 1,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
    })),
    getArtifact: vi.fn(async () => null), // Default: not found
    updateArtifactWithCAS: vi.fn(async () => ({
      success: true,
      artifact: {
        id: 'artifact-1',
        channelId: TEST_CHANNEL_ID,
        slug: 'test-artifact',
        type: 'doc' as const,
        content: '# Test',
        path: 'test_artifact',
        orderKey: '0',
        status: 'done' as const,
        assignees: [],
        labels: [],
        refs: [],
        version: 2,
        createdBy: TEST_CALLSIGN,
        createdAt: '2026-01-01T00:00:00Z',
        updatedBy: TEST_CALLSIGN,
        updatedAt: '2026-01-01T00:01:00Z',
      },
    })),
    editArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      content: '# Updated',
      path: 'test_artifact',
      orderKey: '0',
      status: 'draft' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 2,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
      updatedBy: TEST_CALLSIGN,
      updatedAt: '2026-01-01T00:01:00Z',
    })),
    archiveArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      content: '# Test',
      path: 'test_artifact',
      orderKey: '0',
      status: 'archived' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 2,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
      updatedBy: TEST_CALLSIGN,
      updatedAt: '2026-01-01T00:01:00Z',
    })),
    listArtifacts: vi.fn(async () => []),
    globArtifacts: vi.fn(async () => []),
    checkpointArtifact: vi.fn(async () => ({
      slug: 'test-artifact',
      channelId: TEST_CHANNEL_ID,
      versionName: 'v1.0',
      versionMessage: 'Initial version',
      tldr: 'Test summary',
      content: '# Test',
      versionCreatedBy: TEST_CALLSIGN,
      versionCreatedAt: '2026-01-01T00:00:00Z',
    })),
    getArtifactVersion: vi.fn(async () => null),
    listArtifactVersions: vi.fn(async () => []),
    diffArtifactVersions: vi.fn(async () => ''),

    // Lifecycle
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// =============================================================================
// Mock Asset Storage
// =============================================================================

function createMockAssetStorage(): AssetStorage {
  return {
    saveAsset: vi.fn(async ({ channelId, slug }) => ({
      filePath: `/tmp/.cast-dev/assets/${channelId}/${slug}`,
      contentType: 'image/png',
      fileSize: 1024,
    })),
    readAsset: vi.fn(async () => Buffer.from('fake binary data')),
    assetExists: vi.fn(async () => false),
    deleteAsset: vi.fn(async () => {}),
    getAssetPath: vi.fn((channelId, slug) => `/tmp/.cast-dev/assets/${channelId}/${slug}`),
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function jsonRpcRequest(method: string, params?: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('MCP HTTP Routes (JSON-RPC)', () => {
  let app: Hono;
  let mockStorage: Storage;
  let mockAssetStorage: AssetStorage;
  let token: string;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockAssetStorage = createMockAssetStorage();

    const mcpRoutes = createMcpRoutes({
      storage: mockStorage,
      spaceId: TEST_SPACE_ID,
      assetStorage: mockAssetStorage,
    });

    app = new Hono();
    app.route('/mcp', mcpRoutes);

    // Generate a valid container token
    token = generateContainerToken({
      spaceId: TEST_SPACE_ID,
      channelId: TEST_CHANNEL_ID,
      callsign: TEST_CALLSIGN,
    });
  });

  describe('Authentication', () => {
    it('rejects requests without Authorization header', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Missing Authorization header');
    });

    it('rejects requests with invalid token format', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid' },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid Authorization format');
    });

    it('rejects requests with invalid token', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: { Authorization: 'Container invalid.token' },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Invalid container token');
    });
  });

  describe('JSON-RPC Protocol', () => {
    it('rejects invalid JSON', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: 'not json',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.error.code).toBe(-32700); // Parse error
    });

    it('rejects missing jsonrpc version', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 1, method: 'tools/list' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects missing method', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects missing id', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects unknown method', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('unknown/method'),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32601); // Method not found
    });
  });

  describe('Channel Resolution', () => {
    it('resolves channel by name', async () => {
      const res = await app.request(`/mcp/${TEST_CHANNEL_NAME}`, {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.getChannelByName).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_NAME);
    });

    it('resolves channel by ID when name lookup fails', async () => {
      const res = await app.request(`/mcp/${TEST_CHANNEL_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      // Name lookup tried first (returns null for ID)
      expect(mockStorage.getChannelByName).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_ID);
      // Then ID lookup succeeds
      expect(mockStorage.getChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_ID);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request('/mcp/non-existent', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Channel not found');
    });
  });

  describe('tools/list', () => {
    it('returns all tool definitions', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(1);
      expect(json.result.tools).toBeDefined();
      expect(Array.isArray(json.result.tools)).toBe(true);
      expect(json.result.tools.length).toBe(12); // 10 artifact + 2 message tools

      // Verify tool names
      const toolNames = json.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('artifact_create');
      expect(toolNames).toContain('artifact_read');
      expect(toolNames).toContain('artifact_list');
      expect(toolNames).toContain('artifact_glob');
      expect(toolNames).toContain('artifact_update');
      expect(toolNames).toContain('artifact_edit');
      expect(toolNames).toContain('artifact_archive');
      expect(toolNames).toContain('artifact_checkpoint');
      expect(toolNames).toContain('artifact_diff');
      expect(toolNames).toContain('upload_asset');
      expect(toolNames).toContain('message_get');
      expect(toolNames).toContain('message_search');
    });

    it('includes proper inputSchema for each tool', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      const json = await res.json();
      for (const tool of json.result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('tools/call', () => {
    describe('message_get', () => {
      it('returns messages from storage', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_get', arguments: { limit: 10 } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.jsonrpc).toBe('2.0');
        expect(json.result.isError).toBeUndefined();
        expect(json.result.content).toHaveLength(1);
        expect(json.result.content[0].type).toBe('text');

        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(3);
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].sender).toBe('fox');
      });

      it('respects limit parameter', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_get', arguments: { limit: 2 } }),
        });

        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(2);
      });
    });

    describe('message_search', () => {
      it('filters messages by sender', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_search', arguments: { sender: 'fox' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(2);
        expect(result.messages.every((m: { sender: string }) => m.sender === 'fox')).toBe(true);
      });

      it('filters messages by query', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_search', arguments: { query: 'search' } }),
        });

        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(1);
        expect(result.messages[0].content).toContain('search');
      });
    });

    describe('artifact reads (stubs)', () => {
      it('artifact_list returns empty array', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_list', arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.artifacts).toEqual([]);
      });

      it('artifact_glob returns empty tree', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_glob', arguments: { pattern: '/**' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.content[0].text).toBe('(empty)');
      });

      it('artifact_read returns not found error', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_read', arguments: { slug: 'test-artifact' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Artifact not found');
      });
    });

    describe('artifact writes', () => {
      it('artifact_create creates and returns artifact', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_create',
            arguments: {
              slug: 'test',
              type: 'doc',
              tldr: 'Test document',
              content: '# Test',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.type).toBe('doc');
        expect(mockStorage.createArtifact).toHaveBeenCalled();
      });

      it('artifact_update updates artifact with CAS', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_update',
            arguments: {
              slug: 'test',
              changes: [{ field: 'status', old_value: 'pending', new_value: 'done' }],
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.success).toBe(true);
        expect(mockStorage.updateArtifactWithCAS).toHaveBeenCalled();
      });

      it('artifact_edit performs surgical edit', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_edit',
            arguments: {
              slug: 'test',
              old_string: 'old',
              new_string: 'new',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.version).toBe(2);
        expect(mockStorage.editArtifact).toHaveBeenCalled();
      });

      it('artifact_archive archives artifact', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_archive', arguments: { slug: 'test' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.status).toBe('archived');
        expect(mockStorage.archiveArtifact).toHaveBeenCalled();
      });
    });

    describe('upload_asset', () => {
      it('uploads asset with base64 data', async () => {
        const base64Data = Buffer.from('fake image data').toString('base64');

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'test-image.png',
              tldr: 'A test image',
              data: base64Data,
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.contentType).toBe('image/png');
        expect(result.fileSize).toBe(1024);
        expect(result.url).toContain('/channels/');

        expect(mockAssetStorage.saveAsset).toHaveBeenCalledWith({
          channelId: TEST_CHANNEL_ID,
          slug: 'test-image.png',
          source: { type: 'base64', data: base64Data },
        });
        expect(mockStorage.createArtifact).toHaveBeenCalled();
      });

      it('returns error when neither path nor data provided', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'test-image.png',
              tldr: 'A test image',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Either path or data must be provided');
      });

      it('returns error when both path and data provided', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'test-image.png',
              tldr: 'A test image',
              path: '/tmp/test.png',
              data: 'base64data',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Provide either path OR data, not both');
      });

      it('returns error when slug missing file extension', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'test-image-no-extension',
              tldr: 'A test image',
              data: 'base64data',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Slug must include file extension');
      });

      it('returns error when base64 data exceeds 5MB limit', async () => {
        // Create base64 string that will decode to >5MB
        // 5MB = 5 * 1024 * 1024 bytes = 5242880 bytes
        // Base64 encoding increases size by ~33%, so we need ~7MB of base64
        const largeBase64 = 'A'.repeat(7 * 1024 * 1024);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'large-file.bin',
              tldr: 'A large file',
              data: largeBase64,
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('exceeds 5MB limit');
      });

      it('creates artifact with correct type and encoding', async () => {
        const base64Data = Buffer.from('test').toString('base64');

        await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'upload_asset',
            arguments: {
              slug: 'doc.pdf',
              tldr: 'A PDF document',
              data: base64Data,
            },
          }),
        });

        expect(mockStorage.createArtifact).toHaveBeenCalledWith(
          TEST_CHANNEL_ID,
          expect.objectContaining({
            slug: 'doc.pdf',
            type: 'asset',
            encoding: 'file',
            contentType: 'image/png', // from mock
            fileSize: 1024, // from mock
          })
        );
      });
    });

    describe('error handling', () => {
      it('returns error for unknown tool', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'unknown_tool', arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error.code).toBe(-32601); // Method not found
        expect(json.error.message).toContain('Unknown tool');
      });

      it('returns error for missing tool name', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error.code).toBe(-32602); // Invalid params
        expect(json.error.message).toContain('Missing tool name');
      });
    });
  });
});
