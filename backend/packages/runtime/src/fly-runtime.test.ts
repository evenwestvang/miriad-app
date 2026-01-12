/**
 * FlyRuntime Tests
 *
 * Tests the Fly.io runtime implementation without actual API calls.
 * Uses vi.mock to intercept fetch calls to the Fly Machines API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlyRuntime, type FlyRuntimeConfig } from './fly-runtime.js';
import type { Storage } from '@cast/storage';
import type { RosterEntry } from '@cast/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a valid RosterEntry for tests with all required fields.
 */
function createTestRosterEntry(overrides: Partial<RosterEntry> & { id: string; channelId: string; callsign: string; agentType: string }): RosterEntry {
  return {
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(rosterEntries: Map<string, RosterEntry> = new Map()): Storage {
  const entries = rosterEntries;

  return {
    // Roster methods used by FlyRuntime
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      const key = `${channelId}:${callsign}`;
      return entries.get(key) ?? null;
    }),
    updateRosterEntry: vi.fn(async (channelId: string, entryId: string, updates: Partial<RosterEntry>) => {
      // Find and update the entry
      for (const [key, entry] of entries) {
        if (entry.id === entryId) {
          const updated = { ...entry, ...updates };
          entries.set(key, updated);
          return;
        }
      }
    }),
    // Stubs for other Storage methods (not used by FlyRuntime)
    getChannel: vi.fn(async () => null),
    getChannelByName: vi.fn(async () => null),
    listChannels: vi.fn(async () => []),
    createChannel: vi.fn(async () => ({} as any)),
    updateChannel: vi.fn(async () => {}),
    archiveChannel: vi.fn(async () => {}),
    saveMessage: vi.fn(async () => ({} as any)),
    getMessage: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    addToRoster: vi.fn(async () => ({} as any)),
    getRosterEntry: vi.fn(async () => null),
    listRoster: vi.fn(async () => []),
    removeFromRoster: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as Storage;
}

// =============================================================================
// Mock Fetch
// =============================================================================

interface MockFetchResponse {
  status: number;
  body?: unknown;
  error?: string;
}

function createMockFetch(responses: Map<string, MockFetchResponse>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const method = init?.method ?? 'GET';
    const key = `${method} ${urlStr}`;

    // Find matching response (also check for prefix matches)
    let response = responses.get(key);
    if (!response) {
      // Try prefix matching for dynamic IDs
      for (const [pattern, resp] of responses) {
        if (urlStr.includes(pattern.replace(`${method} `, ''))) {
          response = resp;
          break;
        }
      }
    }

    if (!response) {
      // Default: 404 not found
      return {
        ok: false,
        status: 404,
        text: async () => 'Not found',
        json: async () => ({ error: 'Not found' }),
      };
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.error ?? JSON.stringify(response.body ?? {}),
      json: async () => response.body ?? {},
    };
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('FlyRuntime', () => {
  const TEST_APP_NAME = 'test-app';
  const TEST_REGION = 'iad';
  const TEST_IMAGE = 'registry.fly.io/test-app:latest';
  const TEST_API_URL = 'https://api.test.com';
  const TEST_SPACE_ID = 'test-space';
  const TEST_CHANNEL_ID = 'test-channel';
  const TEST_CALLSIGN = 'fox';
  const TEST_AGENT_ID = `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`;

  let mockStorage: Storage;
  let mockFetch: ReturnType<typeof vi.fn>;
  let runtime: FlyRuntime;
  let originalFetch: typeof fetch;

  const createConfig = (overrides: Partial<FlyRuntimeConfig> = {}): FlyRuntimeConfig => ({
    flyAppName: TEST_APP_NAME,
    flyApiToken: 'test-token',
    flyRegion: TEST_REGION,
    imageName: TEST_IMAGE,
    castApiUrl: TEST_API_URL,
    anthropicApiKey: 'test-anthropic-key',
    storage: mockStorage,
    spaceId: TEST_SPACE_ID,
    activationTimeoutMs: 100, // Short timeout for tests
    ...overrides,
  });

  beforeEach(() => {
    // Save original fetch
    originalFetch = globalThis.fetch;

    // Create mock storage with a roster entry
    const rosterEntries = new Map<string, RosterEntry>();
    rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
      id: 'roster-1',
      channelId: TEST_CHANNEL_ID,
      callsign: TEST_CALLSIGN,
      agentType: 'engineer',
    }));

    mockStorage = createMockStorage(rosterEntries);
  });

  afterEach(async () => {
    // Restore original fetch
    globalThis.fetch = originalFetch;

    // Shutdown runtime if it exists
    if (runtime) {
      await runtime.shutdown();
    }

    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('activate', () => {
    it('creates a new Fly machine when none exists', async () => {
      const responses = new Map<string, MockFetchResponse>();

      // GET machine returns 404 (doesn't exist)
      responses.set('GET /machines/', { status: 404, error: 'Not found' });

      // POST create machine succeeds
      responses.set('POST /machines', {
        status: 200,
        body: {
          id: 'fly-machine-123',
          name: 'test-machine',
          state: 'started',
          region: TEST_REGION,
        },
      });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());
      const state = await runtime.activate({
        agentId: TEST_AGENT_ID,
        authToken: 'test-auth-token',
      });

      expect(state.agentId).toBe(TEST_AGENT_ID);
      expect(state.status).toBe('activating');
      expect(state.container?.runtime).toBe('fly');

      // Should have called createMachine
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/machines'),
        expect.objectContaining({ method: 'POST' })
      );

      // Should have updated roster with routeHints
      expect(mockStorage.updateRosterEntry).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'roster-1',
        expect.objectContaining({
          routeHints: { 'fly-force-instance-id': 'fly-machine-123' },
        })
      );
    });

    it('returns online state if agent already has valid callback URL', async () => {
      // Update mock storage with an online agent
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        callbackUrl: 'https://test-app.fly.dev',
        lastHeartbeat: new Date().toISOString(), // Fresh heartbeat
        routeHints: { 'fly-force-instance-id': 'fly-machine-456' },
      }));

      mockStorage = createMockStorage(rosterEntries);
      mockFetch = createMockFetch(new Map());
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());
      const state = await runtime.activate({
        agentId: TEST_AGENT_ID,
        authToken: 'test-auth-token',
      });

      expect(state.status).toBe('online');
      expect(state.endpoint).toBe('https://test-app.fly.dev');

      // Should NOT have called Fly API (already online)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('starts existing stopped machine', async () => {
      const responses = new Map<string, MockFetchResponse>();

      // GET machine returns stopped state
      responses.set('GET /machines/', {
        status: 200,
        body: {
          id: 'fly-machine-789',
          name: 'test-machine',
          state: 'stopped',
          region: TEST_REGION,
        },
      });

      // POST start machine succeeds
      responses.set('POST /start', { status: 200, body: {} });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());
      const state = await runtime.activate({
        agentId: TEST_AGENT_ID,
        authToken: 'test-auth-token',
      });

      expect(state.status).toBe('activating');

      // Should have called startMachine
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/start'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('throws error if agent not in roster', async () => {
      // Create storage with no roster entries
      mockStorage = createMockStorage(new Map());
      mockFetch = createMockFetch(new Map());
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());

      await expect(
        runtime.activate({
          agentId: TEST_AGENT_ID,
          authToken: 'test-auth-token',
        })
      ).rejects.toThrow('not found in roster');
    });
  });

  describe('suspend', () => {
    it('stops and deletes machine, clears roster', async () => {
      // Setup roster with routeHints containing real Fly ID
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        callbackUrl: 'https://test-app.fly.dev',
        routeHints: { 'fly-force-instance-id': 'fly-machine-999' },
      }));

      mockStorage = createMockStorage(rosterEntries);

      const responses = new Map<string, MockFetchResponse>();
      // POST stop succeeds
      responses.set('POST /stop', { status: 200, body: {} });
      // DELETE succeeds
      responses.set('DELETE /machines/', { status: 204 });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());
      await runtime.suspend(TEST_AGENT_ID, 'test-reason');

      // Should have stopped the machine
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/stop'),
        expect.objectContaining({ method: 'POST' })
      );

      // Should have deleted the machine
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/machines/'),
        expect.objectContaining({ method: 'DELETE' })
      );

      // Should have cleared roster
      expect(mockStorage.updateRosterEntry).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'roster-1',
        expect.objectContaining({
          callbackUrl: undefined,
          routeHints: null,
        })
      );
    });

    it('handles already-deleted machine gracefully', async () => {
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        routeHints: { 'fly-force-instance-id': 'fly-machine-gone' },
      }));

      mockStorage = createMockStorage(rosterEntries);

      const responses = new Map<string, MockFetchResponse>();
      // Stop returns error (machine already stopped)
      responses.set('POST /stop', { status: 404, error: 'machine not found' });
      // DELETE returns 404 (already deleted)
      responses.set('DELETE /machines/', { status: 404, error: 'machine not found' });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());

      // Should not throw
      await expect(runtime.suspend(TEST_AGENT_ID, 'cleanup')).resolves.toBeUndefined();
    });
  });

  describe('sendMessage', () => {
    it('sends message to online agent with routeHints', async () => {
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        callbackUrl: 'https://test-app.fly.dev',
        lastHeartbeat: new Date().toISOString(), // Fresh heartbeat
        routeHints: { 'fly-force-instance-id': 'fly-machine-abc' },
      }));

      mockStorage = createMockStorage(rosterEntries);

      const responses = new Map<string, MockFetchResponse>();
      // Message endpoint succeeds
      responses.set('POST https://test-app.fly.dev/message', { status: 200, body: { ok: true } });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());
      await runtime.sendMessage(TEST_AGENT_ID, { content: 'Hello!' });

      // Should have called container with routeHints header
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-app.fly.dev/message',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'fly-force-instance-id': 'fly-machine-abc',
          }),
        })
      );
    });

    it('throws if agent has no callback URL', async () => {
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        // No callbackUrl
      }));

      mockStorage = createMockStorage(rosterEntries);
      mockFetch = createMockFetch(new Map());
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());

      await expect(
        runtime.sendMessage(TEST_AGENT_ID, { content: 'Hello!' })
      ).rejects.toThrow('no callback URL');
    });

    it('throws if heartbeat is stale', async () => {
      const staleTime = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
      const rosterEntries = new Map<string, RosterEntry>();
      rosterEntries.set(`${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`, createTestRosterEntry({
        id: 'roster-1',
        channelId: TEST_CHANNEL_ID,
        callsign: TEST_CALLSIGN,
        agentType: 'engineer',
        callbackUrl: 'https://test-app.fly.dev',
        lastHeartbeat: staleTime, // Stale heartbeat
      }));

      mockStorage = createMockStorage(rosterEntries);
      mockFetch = createMockFetch(new Map());
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());

      await expect(
        runtime.sendMessage(TEST_AGENT_ID, { content: 'Hello!' })
      ).rejects.toThrow('stale');
    });
  });

  describe('shutdown', () => {
    it('clears activation timers', async () => {
      vi.useFakeTimers();

      const responses = new Map<string, MockFetchResponse>();
      responses.set('GET /machines/', { status: 404 });
      responses.set('POST /machines', {
        status: 200,
        body: { id: 'fly-123', name: 'test', state: 'started', region: 'iad' },
      });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig({ activationTimeoutMs: 10000 }));

      // Start activation (creates timer)
      await runtime.activate({
        agentId: TEST_AGENT_ID,
        authToken: 'test-token',
      });

      // Shutdown should clear timers
      await runtime.shutdown();

      // Advance time past activation timeout - should not trigger cleanup
      // (If timer wasn't cleared, it would try to delete machine)
      const deleteCallsBefore = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === 'DELETE'
      ).length;

      await vi.advanceTimersByTimeAsync(15000);

      const deleteCallsAfter = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === 'DELETE'
      ).length;

      // No additional delete calls should have been made
      expect(deleteCallsAfter).toBe(deleteCallsBefore);
    });
  });

  describe('getState / isOnline / getAllOnline', () => {
    it('returns null/false/empty for sync methods (state is in async storage)', async () => {
      mockFetch = createMockFetch(new Map());
      globalThis.fetch = mockFetch;

      runtime = new FlyRuntime(createConfig());

      // Sync methods can't access async storage
      expect(runtime.getState(TEST_AGENT_ID)).toBeNull();
      expect(runtime.isOnline(TEST_AGENT_ID)).toBe(false);
      expect(runtime.getAllOnline()).toEqual([]);
    });
  });

  describe('activation timeout', () => {
    it('cleans up machine if agent does not come online', async () => {
      vi.useFakeTimers();

      const responses = new Map<string, MockFetchResponse>();
      responses.set('GET /machines/', { status: 404 });
      responses.set('POST /machines', {
        status: 200,
        body: { id: 'fly-timeout-test', name: 'test', state: 'started', region: 'iad' },
      });
      responses.set('DELETE /machines/', { status: 204 });

      mockFetch = createMockFetch(responses);
      globalThis.fetch = mockFetch;

      // Use short timeout
      runtime = new FlyRuntime(createConfig({ activationTimeoutMs: 1000 }));

      // Activate agent
      await runtime.activate({
        agentId: TEST_AGENT_ID,
        authToken: 'test-token',
      });

      // Advance time past activation timeout
      await vi.advanceTimersByTimeAsync(1500);

      // Should have tried to delete the machine
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/machines/'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
