import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';
import type { Storage } from '@cast/storage';
import type { AgentRuntime } from '@cast/runtime';
import type { ConnectionManager } from './websocket/index.js';

// Mock storage - implements Storage interface with no-op stubs
const mockStorage = {
  saveMessage: async () => ({} as never),
  getMessage: async () => null,
  getMessages: async () => [],
  updateMessage: async () => {},
  deleteMessage: async () => {},
  createChannel: async () => ({} as never),
  getChannel: async () => null,
  getChannelById: async () => null,
  getChannelByName: async () => null,
  getChannelWithRoster: async () => null,
  resolveChannel: async () => null,
  listChannels: async () => [],
  updateChannel: async () => {},
  archiveChannel: async () => {},
  addToRoster: async () => ({} as never),
  getRosterEntry: async () => null,
  getRosterByCallsign: async () => null,
  listRoster: async () => [],
  listArchivedRoster: async () => [],
  updateRosterEntry: async () => {},
  removeFromRoster: async () => {},
  initialize: async () => {},
  close: async () => {},
  // Artifact methods
  getArtifact: async () => null,
  listArtifacts: async () => [],
  setArtifactAttachment: async () => {},
  // Space/User methods
  getSpace: async () => null,
  getUser: async () => null,
  // Runtime methods
  getRuntime: async () => null,
  // Cost methods
  saveCostRecord: async () => {},
  getChannelCostTally: async () => [],
  // Secret methods
  getSecretValue: async () => null,
  getSecretMetadata: async () => null,
} as unknown as Storage;

// Mock runtime - implements AgentRuntime interface
const mockRuntime: AgentRuntime = {
  activate: async () => ({
    agentId: '',
    container: null,
    port: null,
    status: 'offline' as const,
    endpoint: null,
    routeHints: null,
    activatedAt: null,
    lastActivityAt: null,
  }),
  sendMessage: async () => {},
  suspend: async () => {},
  getState: () => null,
  isOnline: () => false,
  getAllOnline: () => [],
  shutdown: async () => {},
};

// Mock connection manager
const mockConnectionManager: ConnectionManager = {
  addConnection: () => ({} as never),
  removeConnection: () => {},
  getChannelConnections: () => [],
  getConnection: () => undefined,
  broadcast: async () => {},
  send: async () => {},
  getConnectionCount: () => 0,
  getChannelConnectionCount: () => 0,
  closeAll: () => {},
};

// Create app with mock dependencies
const app = createApp({
  storage: mockStorage,
  runtime: mockRuntime,
  connectionManager: mockConnectionManager,
});

describe('Cast Server', () => {
  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.version).toBe('0.0.1');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('GET /', () => {
    it('returns service info', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.name).toBe('Cast Backend');
      expect(data.version).toBe('0.0.1');
    });
  });
});
