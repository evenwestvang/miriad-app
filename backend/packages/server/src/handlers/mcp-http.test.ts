import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMcpRoutes } from './mcp-http.js';
import { generateContainerToken } from '../auth/container-token.js';
import type { Storage } from '@cast/storage';
import type { StoredMessage, StoredChannel } from '@cast/core';

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

    // Lifecycle
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
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
  let token: string;

  beforeEach(() => {
    mockStorage = createMockStorage();

    const mcpRoutes = createMcpRoutes({
      storage: mockStorage,
      spaceId: TEST_SPACE_ID,
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
      expect(json.result.tools.length).toBe(9); // 7 artifact + 2 message tools

      // Verify tool names
      const toolNames = json.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('artifact_create');
      expect(toolNames).toContain('artifact_read');
      expect(toolNames).toContain('artifact_list');
      expect(toolNames).toContain('artifact_glob');
      expect(toolNames).toContain('artifact_update');
      expect(toolNames).toContain('artifact_edit');
      expect(toolNames).toContain('artifact_archive');
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

    describe('artifact writes (errors)', () => {
      it('artifact_create returns not implemented error', async () => {
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
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('not yet implemented');
      });

      it('artifact_update returns not implemented error', async () => {
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
              changes: [{ field: 'status', oldValue: 'pending', newValue: 'done' }],
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('not yet implemented');
      });

      it('artifact_edit returns not implemented error', async () => {
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
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('not yet implemented');
      });

      it('artifact_archive returns not implemented error', async () => {
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
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('not yet implemented');
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
