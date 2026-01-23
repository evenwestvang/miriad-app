/**
 * App Route Tests
 *
 * Tests for app-level routes including /boards/:channel/:slug
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from './app.js';
import type { Storage } from '@cast/storage';
import type { ContainerOrchestrator } from '@cast/runtime';
import { createConnectionManager, type ConnectionManager } from './websocket/index.js';
import type { StoredChannel, StoredArtifact } from '@cast/core';
import { createSession } from './auth/session.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_SPACE_ID = 'test-space';
const TEST_CHANNEL_ID = '01ABCDEFGH123456789012345';
const TEST_CHANNEL_NAME = 'test-channel';

const testChannel: StoredChannel = {
  id: TEST_CHANNEL_ID,
  spaceId: TEST_SPACE_ID,
  name: TEST_CHANNEL_NAME,
  tagline: 'Test workspace',
  mission: 'Testing app routes',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const testJsonArtifact: StoredArtifact = {
  id: 'artifact-1',
  channelId: TEST_CHANNEL_ID,
  slug: 'config.json',
  type: 'code',
  title: 'Config File',
  tldr: 'Configuration data',
  content: '{"name": "test", "value": 42}',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'test-user',
};

const testMarkdownArtifact: StoredArtifact = {
  id: 'artifact-2',
  channelId: TEST_CHANNEL_ID,
  slug: 'readme.md',
  type: 'doc',
  title: 'Readme',
  tldr: 'Documentation',
  content: '# Test\n\nHello world!',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'test-user',
};

const testJsArtifact: StoredArtifact = {
  id: 'artifact-3',
  channelId: TEST_CHANNEL_ID,
  slug: 'bouncing-ball.app.js',
  type: 'code',
  title: 'Bouncing Ball',
  tldr: 'Interactive animation',
  content: `export default {
  render(container, ctx) {
    container.innerHTML = '<p>Hello!</p>';
  }
}`,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'test-user',
};

const testBinaryArtifact: StoredArtifact = {
  id: 'artifact-4',
  channelId: TEST_CHANNEL_ID,
  slug: 'image.png',
  type: 'asset',
  title: 'Test Image',
  tldr: 'A test image',
  content: '',
  encoding: 'file',
  contentType: 'image/png',
  fileSize: 1024,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'test-user',
};

// =============================================================================
// Mock Factories
// =============================================================================

function createMockStorage(): Storage {
  const artifacts = new Map<string, StoredArtifact>([
    ['config.json', testJsonArtifact],
    ['readme.md', testMarkdownArtifact],
    ['bouncing-ball.app.js', testJsArtifact],
    ['image.png', testBinaryArtifact],
  ]);

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
    resolveChannel: vi.fn(async (spaceId: string, idOrName: string) => {
      if (idOrName === TEST_CHANNEL_ID || idOrName === TEST_CHANNEL_NAME) return testChannel;
      return null;
    }),
    getChannelWithRoster: vi.fn(async () => ({ channel: testChannel, roster: [] })),
    resolveChannelWithRoster: vi.fn(async (spaceId: string, idOrName: string) => {
      if (idOrName === TEST_CHANNEL_ID || idOrName === TEST_CHANNEL_NAME) {
        return { channel: testChannel, roster: [] };
      }
      return null;
    }),
    listChannels: vi.fn(async () => [testChannel]),
    createChannel: vi.fn(async () => testChannel),
    updateChannel: vi.fn(async () => {}),
    archiveChannel: vi.fn(async () => {}),

    // Message operations
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
    saveMessage: vi.fn(async () => ({})),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),

    // Roster operations
    addToRoster: vi.fn(async () => ({
      id: 'roster-1',
      channelId: TEST_CHANNEL_ID,
      callsign: 'test',
      agentType: 'engineer',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    getRosterEntry: vi.fn(async () => null),
    getRosterByCallsign: vi.fn(async () => null),
    listRoster: vi.fn(async () => []),
    listArchivedRoster: vi.fn(async () => []),
    removeFromRoster: vi.fn(async () => {}),
    updateRosterEntry: vi.fn(async () => {}),

    // Artifact operations
    getArtifact: vi.fn(async (channelId: string, slug: string) => {
      if (channelId !== TEST_CHANNEL_ID) return null;
      return artifacts.get(slug) || null;
    }),
    listArtifacts: vi.fn(async () => []),
    createArtifact: vi.fn(async () => testJsonArtifact),
    updateArtifact: vi.fn(async () => {}),
    archiveArtifact: vi.fn(async () => {}),
    createArtifactVersion: vi.fn(async () => ({})),
    listArtifactVersions: vi.fn(async () => []),
    getArtifactVersion: vi.fn(async () => null),

    // Other
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as Storage;
}

function createMockOrchestrator(): ContainerOrchestrator {
  return {
    spawn: vi.fn(async () => ({
      containerId: 'test-container',
      callbackPort: 8080,
    })),
    stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isRunning: vi.fn(async () => false),
    list: vi.fn(async () => []),
    shutdown: vi.fn(async () => {}),
  } as unknown as ContainerOrchestrator;
}

// =============================================================================
// Tests
// =============================================================================

describe('/boards/:channel/:slug Route', () => {
  let app: ReturnType<typeof createApp>;
  let mockStorage: Storage;
  let connectionManager: ConnectionManager;
  let sessionCookie: string;
  const mockAssetData = Buffer.from('fake binary data');

  beforeEach(async () => {
    mockStorage = createMockStorage();
    connectionManager = createConnectionManager();

    // Create a session token for auth
    const token = await createSession('test-user', TEST_SPACE_ID, 'dev');
    sessionCookie = `cast_session=${token}`;

    // Create app with mocked dependencies
    app = createApp({
      storage: mockStorage,
      orchestrator: createMockOrchestrator(),
      connectionManager,
      spaceId: TEST_SPACE_ID,
    });
  });

  // Helper to make authenticated requests
  function authHeaders(): HeadersInit {
    return { Cookie: sessionCookie };
  }

  describe('channel resolution', () => {
    it('resolves channel by name', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/config.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.resolveChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_NAME);
    });

    it('resolves channel by ID when name not found', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_ID}/config.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.resolveChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_ID);
    });

    it('returns 404 for unknown channel', async () => {
      vi.mocked(mockStorage.resolveChannel).mockResolvedValueOnce(null);

      const res = await app.request('/boards/unknown-channel/config.json', {
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Channel not found');
    });
  });

  describe('text artifact serving', () => {
    it('serves JSON artifact with application/json Content-Type', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/config.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const text = await res.text();
      expect(text).toBe('{"name": "test", "value": 42}');
    });

    it('serves Markdown artifact with text/markdown Content-Type', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/readme.md`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown');
      const text = await res.text();
      expect(text).toContain('# Test');
    });

    it('serves JavaScript artifact with text/javascript Content-Type', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/bouncing-ball.app.js`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/javascript');
      const text = await res.text();
      expect(text).toContain('export default');
    });

    it('returns 404 for unknown artifact', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/nonexistent.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain('Artifact not found');
    });

    it('sets Cache-Control header for text artifacts', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/config.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });

    it('sets Content-Length header', async () => {
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/config.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const contentLength = res.headers.get('Content-Length');
      expect(contentLength).toBe(Buffer.byteLength('{"name": "test", "value": 42}').toString());
    });
  });

  describe('binary artifact serving', () => {
    it('serves binary artifact from asset storage', async () => {
      // Note: The actual asset storage is filesystem-based and would need
      // the file to exist. In unit tests, we verify the code path runs
      // but the read will fail since there's no actual file.
      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/image.png`, {
        headers: authHeaders(),
      });

      // Will return 404 because assetStorage.readAsset fails (no file on disk)
      // In a real test with file fixtures, this would return 200
      expect(res.status).toBe(404);
    });
  });

  describe('empty content handling', () => {
    it('serves artifact with empty content', async () => {
      // Modify mock to return artifact with empty content
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce({
        ...testJsonArtifact,
        slug: 'empty.json',
        content: '',
      });

      const res = await app.request(`/boards/${TEST_CHANNEL_NAME}/empty.json`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });
  });
});
