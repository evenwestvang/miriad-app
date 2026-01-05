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
const TEST_CHANNEL_ID = 'test-channel';
const TEST_CALLSIGN = 'test-agent';

const testChannel: StoredChannel = {
  id: TEST_CHANNEL_ID,
  spaceId: TEST_SPACE_ID,
  name: 'test-channel',
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
    getChannelByName: vi.fn(async () => null),
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
// Tests
// =============================================================================

describe('MCP HTTP Routes', () => {
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
      const res = await app.request('/mcp/test-channel/tools/list', {
        method: 'POST',
        body: '{}',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Missing Authorization header');
    });

    it('rejects requests with invalid token format', async () => {
      const res = await app.request('/mcp/test-channel/tools/list', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid' },
        body: '{}',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid Authorization format');
    });

    it('rejects requests with invalid token', async () => {
      const res = await app.request('/mcp/test-channel/tools/list', {
        method: 'POST',
        headers: { Authorization: 'Container invalid.token' },
        body: '{}',
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Invalid container token');
    });
  });

  describe('POST /mcp/:channelId/tools/list', () => {
    it('returns all tool definitions with valid auth', async () => {
      const res = await app.request('/mcp/test-channel/tools/list', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: '{}',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.tools).toBeDefined();
      expect(Array.isArray(json.tools)).toBe(true);
      expect(json.tools.length).toBe(9); // 7 artifact + 2 message tools

      // Verify tool names
      const toolNames = json.tools.map((t: { name: string }) => t.name);
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

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request('/mcp/non-existent/tools/list', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: '{}',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Channel not found');
    });

    it('includes proper inputSchema for each tool', async () => {
      const res = await app.request('/mcp/test-channel/tools/list', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: '{}',
      });

      const json = await res.json();
      for (const tool of json.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('POST /mcp/:channelId/tools/call', () => {
    describe('message_get', () => {
      it('returns messages from storage', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'message_get',
            arguments: { limit: 10 },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.isError).toBeUndefined();
        expect(json.content).toHaveLength(1);
        expect(json.content[0].type).toBe('text');

        const result = JSON.parse(json.content[0].text);
        expect(result.count).toBe(3);
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].sender).toBe('fox');
      });

      it('respects limit parameter', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'message_get',
            arguments: { limit: 2 },
          }),
        });

        const json = await res.json();
        const result = JSON.parse(json.content[0].text);
        expect(result.count).toBe(2);
      });
    });

    describe('message_search', () => {
      it('filters messages by sender', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'message_search',
            arguments: { sender: 'fox' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.content[0].text);
        expect(result.count).toBe(2);
        expect(result.messages.every((m: { sender: string }) => m.sender === 'fox')).toBe(true);
      });

      it('filters messages by query', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'message_search',
            arguments: { query: 'search' },
          }),
        });

        const json = await res.json();
        const result = JSON.parse(json.content[0].text);
        expect(result.count).toBe(1);
        expect(result.messages[0].content).toContain('search');
      });
    });

    describe('artifact reads (stubs)', () => {
      it('artifact_list returns empty array', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'artifact_list',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.isError).toBeUndefined();

        const result = JSON.parse(json.content[0].text);
        expect(result.artifacts).toEqual([]);
      });

      it('artifact_glob returns empty tree', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'artifact_glob',
            arguments: { pattern: '/**' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.content[0].text).toBe('(empty)');
      });

      it('artifact_read returns not found error', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'artifact_read',
            arguments: { slug: 'test-artifact' },
          }),
        });

        expect(res.status).toBe(200); // MCP returns 200 for tool errors
        const json = await res.json();
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('Artifact not found');
      });
    });

    describe('artifact writes (errors)', () => {
      it('artifact_create returns not implemented error', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
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
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('not yet implemented');
      });

      it('artifact_update returns not implemented error', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'artifact_update',
            arguments: {
              slug: 'test',
              changes: [{ field: 'status', oldValue: 'pending', newValue: 'done' }],
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('not yet implemented');
      });

      it('artifact_edit returns not implemented error', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
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
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('not yet implemented');
      });

      it('artifact_archive returns not implemented error', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'artifact_archive',
            arguments: { slug: 'test' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('not yet implemented');
      });
    });

    describe('error handling', () => {
      it('returns error for unknown tool', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'unknown_tool',
            arguments: {},
          }),
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('Unknown tool');
      });

      it('returns error for missing tool name', async () => {
        const res = await app.request('/mcp/test-channel/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            arguments: {},
          }),
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.isError).toBe(true);
        expect(json.content[0].text).toContain('Missing tool name');
      });

      it('returns 404 for non-existent channel', async () => {
        const res = await app.request('/mcp/non-existent/tools/call', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'message_get',
            arguments: {},
          }),
        });

        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.error).toBe('Channel not found');
      });
    });
  });
});
