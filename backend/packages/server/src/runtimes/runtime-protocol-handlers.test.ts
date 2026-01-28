/**
 * RuntimeProtocolHandlers Tests
 *
 * Tests for agent state management:
 * - Paused/archived agents cannot send frames
 * - Disconnect clears all runtime bindings
 * - Frame handler respects roster status
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRuntimeProtocolHandlers, type RuntimeConnectionState } from './runtime-protocol-handlers.js';
import type { Storage } from '@cast/storage';
import type { SetFrame } from '@cast/core';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_SPACE_ID = 'space_test';
const TEST_CHANNEL_ID = 'ch_test123';
const TEST_RUNTIME_ID = 'rt_test456';
const TEST_CALLSIGN = 'fox';
// AgentId format is spaceId:channelId:callsign
const TEST_AGENT_ID = `${TEST_SPACE_ID}:${TEST_CHANNEL_ID}:${TEST_CALLSIGN}`;
const TEST_CONNECTION_ID = 'conn_789';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockStorage() {
  const rosterEntries = new Map<string, {
    id: string;
    channelId: string;
    callsign: string;
    status: string;
    runtimeId?: string;
    lastHeartbeat?: string;
    callbackUrl?: string;
  }>();

  return {
    getRosterByCallsign: vi.fn(async (channelId: string, callsign: string) => {
      return rosterEntries.get(`${channelId}:${callsign}`) ?? null;
    }),
    updateRosterEntry: vi.fn(async (channelId: string, rosterId: string, update: Record<string, unknown>) => {
      // Find and update the entry
      for (const [key, entry] of rosterEntries.entries()) {
        if (entry.id === rosterId) {
          Object.assign(entry, update);
          break;
        }
      }
    }),
    getAgentsByRuntime: vi.fn(async (runtimeId: string) => {
      const agents: Array<{ id: string; channelId: string; callsign: string }> = [];
      for (const entry of rosterEntries.values()) {
        if (entry.runtimeId === runtimeId) {
          agents.push({ id: entry.id, channelId: entry.channelId, callsign: entry.callsign });
        }
      }
      return agents;
    }),
    updateRuntime: vi.fn(async () => {}),
    saveMessage: vi.fn(async () => ({ id: 'msg_1' })),
    saveCostRecord: vi.fn(async () => ({})),
    getChannelById: vi.fn(async () => ({ id: TEST_CHANNEL_ID, spaceId: TEST_SPACE_ID, name: 'test' })),

    // Test helpers
    _setRosterEntry: (channelId: string, callsign: string, status: string, runtimeId?: string) => {
      rosterEntries.set(`${channelId}:${callsign}`, {
        id: `roster_${callsign}`,
        channelId,
        callsign,
        status,
        runtimeId,
        lastHeartbeat: new Date().toISOString(),
        callbackUrl: undefined,
      });
    },
    _getRosterEntry: (channelId: string, callsign: string) => {
      return rosterEntries.get(`${channelId}:${callsign}`);
    },
    _rosterEntries: rosterEntries,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('RuntimeProtocolHandlers', () => {
  let handlers: ReturnType<typeof createRuntimeProtocolHandlers>;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockSend: ReturnType<typeof vi.fn>;
  let mockSendError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockBroadcast = vi.fn(async () => {});
    mockSend = vi.fn(async () => true);
    mockSendError = vi.fn(async () => {});

    handlers = createRuntimeProtocolHandlers({
      storage: mockStorage as unknown as Storage,
      broadcast: mockBroadcast,
      send: mockSend,
      sendError: mockSendError,
    });
  });

  describe('handleFrame', () => {
    const createConnectionState = (runtimeId: string | null = TEST_RUNTIME_ID): RuntimeConnectionState => ({
      connectionId: TEST_CONNECTION_ID,
      channelId: TEST_CHANNEL_ID,
      protocol: 'runtime',
      runtimeId,
      spaceId: TEST_SPACE_ID,
    });

    const createFrameMessage = (content: string) => {
      const frame: SetFrame = {
        i: 'msg_123',
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: TEST_CALLSIGN,
          senderType: 'agent',
          content,
        },
      };
      return {
        agentId: TEST_AGENT_ID,
        frame,
      };
    };

    it('should broadcast frame from active agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'active', TEST_RUNTIME_ID);

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Hello world'));

      expect(mockBroadcast).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.stringContaining('Hello world')
      );
    });

    it('should block frame from paused agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'paused', TEST_RUNTIME_ID);

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Should not appear'));

      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should block frame from archived agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'archived', TEST_RUNTIME_ID);

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Should not appear'));

      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should block frame from unknown agent', async () => {
      // Don't set up any roster entry

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Unknown agent'));

      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should update lastHeartbeat for active agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'active', TEST_RUNTIME_ID);

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Hello'));

      expect(mockStorage.updateRosterEntry).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        `roster_${TEST_CALLSIGN}`,
        expect.objectContaining({ lastHeartbeat: expect.any(String) })
      );
    });

    it('should NOT update lastHeartbeat for paused agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'paused', TEST_RUNTIME_ID);

      await handlers.handleFrame(createConnectionState(), createFrameMessage('Paused'));

      expect(mockStorage.updateRosterEntry).not.toHaveBeenCalled();
    });

    it('should reject frame when runtime not registered', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'active');

      await handlers.handleFrame(createConnectionState(null), createFrameMessage('No runtime'));

      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(
        TEST_CONNECTION_ID,
        'NOT_REGISTERED',
        expect.any(String)
      );
    });
  });

  describe('handleDisconnect', () => {
    it('should clear all runtime bindings on disconnect', async () => {
      // Set up two agents bound to the same runtime
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, 'fox', 'active', TEST_RUNTIME_ID);
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, 'bear', 'active', TEST_RUNTIME_ID);

      await handlers.handleDisconnect(TEST_RUNTIME_ID);

      // Both agents should have bindings cleared
      expect(mockStorage.updateRosterEntry).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'roster_fox',
        expect.objectContaining({
          runtimeId: undefined,
          lastHeartbeat: undefined,
          callbackUrl: undefined,
        })
      );
      expect(mockStorage.updateRosterEntry).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'roster_bear',
        expect.objectContaining({
          runtimeId: undefined,
          lastHeartbeat: undefined,
          callbackUrl: undefined,
        })
      );
    });

    it('should mark runtime as offline', async () => {
      await handlers.handleDisconnect(TEST_RUNTIME_ID);

      expect(mockStorage.updateRuntime).toHaveBeenCalledWith(
        TEST_RUNTIME_ID,
        expect.objectContaining({ status: 'offline' })
      );
    });

    it('should broadcast offline status for each disconnected agent', async () => {
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, 'fox', 'active', TEST_RUNTIME_ID);

      await handlers.handleDisconnect(TEST_RUNTIME_ID);

      expect(mockBroadcast).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.stringContaining('offline')
      );
    });

    it('should broadcast agent_state frame (not status frame) on disconnect', async () => {
      // This test ensures the frontend receives the correct frame type
      // Frontend expects: { type: 'agent_state', state: 'offline' }
      // NOT: { type: 'status', content: 'offline...' }
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, 'fox', 'active', TEST_RUNTIME_ID);

      await handlers.handleDisconnect(TEST_RUNTIME_ID);

      // Verify broadcast was called
      expect(mockBroadcast).toHaveBeenCalled();
      
      // Parse the broadcast payload and verify frame structure
      const broadcastCall = mockBroadcast.mock.calls.find(
        call => call[0] === TEST_CHANNEL_ID
      );
      expect(broadcastCall).toBeDefined();
      
      const frameStr = broadcastCall![1];
      const frame = JSON.parse(frameStr);
      
      // Must be agent_state type for frontend to handle it
      expect(frame.v.type).toBe('agent_state');
      expect(frame.v.state).toBe('offline');
      expect(frame.v.sender).toBe('fox');
    });
  });
});

describe('Agent State Transitions', () => {
  /**
   * These tests verify the complete state machine for agent lifecycle.
   * The actual pause/dismiss handlers are in app.ts, but we test the
   * invariants that the protocol handlers must respect.
   */

  describe('State Invariants', () => {
    it('paused agent: no messages in, no messages out', async () => {
      const mockStorage = createMockStorage();
      const mockBroadcast = vi.fn(async () => {});
      const mockSend = vi.fn(async () => true);
      const mockSendError = vi.fn(async () => {});

      const handlers = createRuntimeProtocolHandlers({
        storage: mockStorage as unknown as Storage,
        broadcast: mockBroadcast,
        send: mockSend,
        sendError: mockSendError,
      });

      // Agent is paused
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'paused', TEST_RUNTIME_ID);

      // Try to send a frame
      const state: RuntimeConnectionState = {
        connectionId: TEST_CONNECTION_ID,
        channelId: TEST_CHANNEL_ID,
        protocol: 'runtime',
        runtimeId: TEST_RUNTIME_ID,
        spaceId: TEST_SPACE_ID,
      };

      const frame: SetFrame = {
        i: 'msg_1',
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: TEST_CALLSIGN,
          senderType: 'agent',
          content: 'This should be blocked',
        },
      };
      await handlers.handleFrame(state, {
        agentId: TEST_AGENT_ID,
        frame,
      });

      // Frame should NOT be broadcast
      expect(mockBroadcast).not.toHaveBeenCalled();
      // Heartbeat should NOT be updated
      expect(mockStorage.updateRosterEntry).not.toHaveBeenCalled();
    });

    it('archived agent: no messages in, no messages out', async () => {
      const mockStorage = createMockStorage();
      const mockBroadcast = vi.fn(async () => {});
      const mockSend = vi.fn(async () => true);
      const mockSendError = vi.fn(async () => {});

      const handlers = createRuntimeProtocolHandlers({
        storage: mockStorage as unknown as Storage,
        broadcast: mockBroadcast,
        send: mockSend,
        sendError: mockSendError,
      });

      // Agent is archived (dismissed)
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'archived', TEST_RUNTIME_ID);

      const state: RuntimeConnectionState = {
        connectionId: TEST_CONNECTION_ID,
        channelId: TEST_CHANNEL_ID,
        protocol: 'runtime',
        runtimeId: TEST_RUNTIME_ID,
        spaceId: TEST_SPACE_ID,
      };

      // Try to send a frame
      const frame2: SetFrame = {
        i: 'msg_1',
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: TEST_CALLSIGN,
          senderType: 'agent',
          content: 'This should be blocked',
        },
      };
      await handlers.handleFrame(state, {
        agentId: TEST_AGENT_ID,
        frame: frame2,
      });

      // Frame should NOT be broadcast
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('active agent: messages flow normally', async () => {
      const mockStorage = createMockStorage();
      const mockBroadcast = vi.fn(async () => {});
      const mockSend = vi.fn(async () => true);
      const mockSendError = vi.fn(async () => {});

      const handlers = createRuntimeProtocolHandlers({
        storage: mockStorage as unknown as Storage,
        broadcast: mockBroadcast,
        send: mockSend,
        sendError: mockSendError,
      });

      // Agent is active
      mockStorage._setRosterEntry(TEST_CHANNEL_ID, TEST_CALLSIGN, 'active', TEST_RUNTIME_ID);

      const state: RuntimeConnectionState = {
        connectionId: TEST_CONNECTION_ID,
        channelId: TEST_CHANNEL_ID,
        protocol: 'runtime',
        runtimeId: TEST_RUNTIME_ID,
        spaceId: TEST_SPACE_ID,
      };

      // Send a frame
      const frame: SetFrame = {
        i: 'msg_1',
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: TEST_CALLSIGN,
          senderType: 'agent',
          content: 'Hello from active agent',
        },
      };
      await handlers.handleFrame(state, {
        agentId: TEST_AGENT_ID,
        frame,
      });

      // Frame SHOULD be broadcast
      expect(mockBroadcast).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.stringContaining('Hello from active agent')
      );
      // Heartbeat SHOULD be updated
      expect(mockStorage.updateRosterEntry).toHaveBeenCalled();
    });
  });
});
