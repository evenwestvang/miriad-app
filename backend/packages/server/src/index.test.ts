import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';
import type { Storage } from '@cast/storage';
import type { ContainerOrchestrator } from '@cast/runtime';
import type { ConnectionManager } from './websocket/index.js';

// Mock storage
const mockStorage: Storage = {
  saveMessage: async () => ({} as never),
  getMessage: async () => null,
  getMessages: async () => [],
  updateMessage: async () => {},
  deleteMessage: async () => {},
  createChannel: async () => ({} as never),
  getChannel: async () => null,
  getChannelByName: async () => null,
  listChannels: async () => [],
  updateChannel: async () => {},
  archiveChannel: async () => {},
  addToRoster: async () => ({} as never),
  getRosterEntry: async () => null,
  getRosterByCallsign: async () => null,
  listRoster: async () => [],
  updateRosterEntry: async () => {},
  removeFromRoster: async () => {},
  initialize: async () => {},
  close: async () => {},
};

// Mock orchestrator
const mockOrchestrator: ContainerOrchestrator = {
  spawn: async () => ({ threadId: '', containerId: '', status: 'running' as const }),
  sendMessage: async () => {},
  getState: async () => null,
  stop: async () => {},
  stopAll: async () => {},
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
  orchestrator: mockOrchestrator,
  connectionManager: mockConnectionManager,
  spaceId: 'test-space',
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
