/**
 * LocalRuntime Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalRuntime, createLocalRuntime, type RuntimeConnectionManager } from './local-runtime.js';
import { AgentStateManager } from './state.js';

// =============================================================================
// Mock RuntimeConnectionManager
// =============================================================================

function createMockConnectionManager(): RuntimeConnectionManager & {
  _commands: Array<{ runtimeId: string; command: unknown }>;
  _online: Set<string>;
} {
  const commands: Array<{ runtimeId: string; command: unknown }> = [];
  const online = new Set<string>();

  return {
    _commands: commands,
    _online: online,
    sendCommand: vi.fn((runtimeId: string, command: unknown) => {
      if (!online.has(runtimeId)) return false;
      commands.push({ runtimeId, command });
      return true;
    }),
    isRuntimeOnline: vi.fn((runtimeId: string) => online.has(runtimeId)),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('LocalRuntime', () => {
  let runtime: LocalRuntime;
  let stateManager: AgentStateManager;
  let connectionManager: ReturnType<typeof createMockConnectionManager>;
  let events: Array<{ type: string; agentId: string; [key: string]: unknown }>;

  const RUNTIME_ID = 'rt_001';
  const SPACE_ID = 'space_123';
  const AGENT_ID = 'space_123:channel_1:fox';

  beforeEach(() => {
    stateManager = new AgentStateManager();
    connectionManager = createMockConnectionManager();
    events = [];

    runtime = createLocalRuntime({
      runtimeId: RUNTIME_ID,
      spaceId: SPACE_ID,
      connectionManager,
      stateManager,
      workspaceBasePath: '/tmp/test-agents',
      onEvent: (event) => {
        events.push(event as typeof events[number]);
      },
    });

    // Mark runtime as online by default
    connectionManager._online.add(RUNTIME_ID);
  });

  describe('activate', () => {
    it('should send activate command and return activating state', async () => {
      const state = await runtime.activate({
        agentId: AGENT_ID,
        authToken: 'token_123',
        systemPrompt: 'You are fox',
        mcpServers: [{ name: 'test', transport: 'stdio', command: 'test-cmd' }],
      });

      expect(state.status).toBe('activating');
      expect(state.agentId).toBe(AGENT_ID);
      expect(state.container?.containerId).toBe(RUNTIME_ID);
      expect(state.container?.runtime).toBe('local');

      // Should have sent command
      expect(connectionManager.sendCommand).toHaveBeenCalledWith(
        RUNTIME_ID,
        expect.objectContaining({
          type: 'activate',
          agentId: AGENT_ID,
          systemPrompt: 'You are fox',
          workspacePath: '/tmp/test-agents/space_123/channel_1/fox',
        })
      );

      // Should emit activating event
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'agent_activating', agentId: AGENT_ID })
      );
    });

    it('should be idempotent when agent already activating', async () => {
      // First activation
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      // Reset mocks
      vi.mocked(connectionManager.sendCommand).mockClear();

      // Second activation
      const state = await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      expect(state.status).toBe('activating');
      // Should NOT send another command
      expect(connectionManager.sendCommand).not.toHaveBeenCalled();
    });

    it('should be idempotent when agent already online', async () => {
      // Set up as online
      stateManager.handleActivate(AGENT_ID);
      stateManager.handleCheckin(AGENT_ID);
      expect(stateManager.getState(AGENT_ID)?.status).toBe('online');

      vi.mocked(connectionManager.sendCommand).mockClear();

      const state = await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      expect(state.status).toBe('online');
      expect(connectionManager.sendCommand).not.toHaveBeenCalled();
    });

    it('should throw if runtime not connected', async () => {
      connectionManager._online.delete(RUNTIME_ID);

      await expect(
        runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' })
      ).rejects.toThrow('not connected');
    });

    it('should throw if sendCommand fails', async () => {
      vi.mocked(connectionManager.sendCommand).mockReturnValue(false);

      await expect(
        runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' })
      ).rejects.toThrow('Failed to send activate command');
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      // Set up agent as online
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      stateManager.handleCheckin(AGENT_ID);
      connectionManager._commands.length = 0; // Clear activation command
    });

    it('should send message to online agent', async () => {
      await runtime.sendMessage(AGENT_ID, {
        content: 'Hello fox',
        systemPrompt: 'Be helpful',
      });

      expect(connectionManager.sendCommand).toHaveBeenCalledWith(
        RUNTIME_ID,
        expect.objectContaining({
          type: 'message',
          agentId: AGENT_ID,
          content: 'Hello fox',
          systemPrompt: 'Be helpful',
        })
      );
    });

    it('should throw if agent not online', async () => {
      stateManager.handleSuspend(AGENT_ID);

      await expect(
        runtime.sendMessage(AGENT_ID, { content: 'Hello' })
      ).rejects.toThrow('not online');
    });

    it('should throw if runtime disconnected', async () => {
      connectionManager._online.delete(RUNTIME_ID);

      await expect(
        runtime.sendMessage(AGENT_ID, { content: 'Hello' })
      ).rejects.toThrow('not connected');
    });
  });

  describe('suspend', () => {
    beforeEach(async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      stateManager.handleCheckin(AGENT_ID);
      connectionManager._commands.length = 0;
      events.length = 0;
    });

    it('should send suspend command and update state', async () => {
      await runtime.suspend(AGENT_ID, 'user requested');

      expect(connectionManager.sendCommand).toHaveBeenCalledWith(
        RUNTIME_ID,
        expect.objectContaining({
          type: 'suspend',
          agentId: AGENT_ID,
          reason: 'user requested',
        })
      );

      expect(stateManager.getState(AGENT_ID)?.status).toBe('offline');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'agent_offline',
          agentId: AGENT_ID,
          reason: 'user requested',
        })
      );
    });

    it('should be idempotent when already offline', async () => {
      stateManager.handleSuspend(AGENT_ID);
      vi.mocked(connectionManager.sendCommand).mockClear();

      await runtime.suspend(AGENT_ID);

      // Should not send command
      expect(connectionManager.sendCommand).not.toHaveBeenCalled();
    });

    it('should update state even if runtime disconnected', async () => {
      connectionManager._online.delete(RUNTIME_ID);

      await runtime.suspend(AGENT_ID, 'cleanup');

      // State should still be updated
      expect(stateManager.getState(AGENT_ID)?.status).toBe('offline');
    });
  });

  describe('getState', () => {
    it('should return null for unknown agent', () => {
      expect(runtime.getState('unknown:agent:id')).toBeNull();
    });

    it('should return state for known agent', async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      const state = runtime.getState(AGENT_ID);
      expect(state).not.toBeNull();
      expect(state?.agentId).toBe(AGENT_ID);
    });
  });

  describe('isOnline', () => {
    it('should return false for unknown agent', () => {
      expect(runtime.isOnline('unknown:agent:id')).toBe(false);
    });

    it('should return false for offline agent', async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      expect(runtime.isOnline(AGENT_ID)).toBe(false); // Still activating
    });

    it('should return true for online agent', async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      stateManager.handleCheckin(AGENT_ID);
      expect(runtime.isOnline(AGENT_ID)).toBe(true);
    });
  });

  describe('getAllOnline', () => {
    it('should return empty array when no agents', () => {
      expect(runtime.getAllOnline()).toEqual([]);
    });

    it('should return only online agents on this runtime', async () => {
      // Activate and checkin agent
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      stateManager.handleCheckin(AGENT_ID);

      // Add another agent on different runtime (simulate)
      const otherAgentId = 'space_123:channel_1:bear';
      stateManager.handleActivate(otherAgentId, {
        container: { containerId: 'rt_other', runtime: 'local' },
      });
      stateManager.handleCheckin(otherAgentId);

      const online = runtime.getAllOnline();

      expect(online).toHaveLength(1);
      expect(online[0].agentId).toBe(AGENT_ID);
    });
  });

  describe('shutdown', () => {
    it('should suspend all online agents', async () => {
      // Activate and checkin two agents
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      stateManager.handleCheckin(AGENT_ID);

      const agent2Id = 'space_123:channel_1:bear';
      stateManager.handleActivate(agent2Id, {
        container: { containerId: RUNTIME_ID, runtime: 'local' },
      });
      stateManager.handleCheckin(agent2Id);

      await runtime.shutdown();

      expect(stateManager.getState(AGENT_ID)?.status).toBe('offline');
      expect(stateManager.getState(agent2Id)?.status).toBe('offline');
    });
  });

  describe('event handlers', () => {
    beforeEach(async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });
      events.length = 0;
    });

    describe('handleAgentCheckin', () => {
      it('should update state to online and emit event', () => {
        const state = runtime.handleAgentCheckin(AGENT_ID);

        expect(state.status).toBe('online');
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_online',
            agentId: AGENT_ID,
          })
        );
      });
    });

    describe('handleAgentFrame', () => {
      beforeEach(() => {
        stateManager.handleCheckin(AGENT_ID);
      });

      it('should update state to busy on non-idle frame', () => {
        const state = runtime.handleAgentFrame(AGENT_ID, false);
        expect(state.status).toBe('busy');
      });

      it('should update state to online on idle frame', () => {
        stateManager.handleFrame(AGENT_ID, false); // Set to busy first
        const state = runtime.handleAgentFrame(AGENT_ID, true);
        expect(state.status).toBe('online');
      });
    });

    describe('handleAgentError', () => {
      it('should update state to error and emit event', () => {
        stateManager.handleCheckin(AGENT_ID);

        const state = runtime.handleAgentError(AGENT_ID);

        expect(state.status).toBe('error');
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_error',
            agentId: AGENT_ID,
          })
        );
      });
    });

    describe('handleRuntimeDisconnect', () => {
      it('should mark all agents offline', async () => {
        stateManager.handleCheckin(AGENT_ID);

        // Add another agent
        const agent2Id = 'space_123:channel_1:bear';
        stateManager.handleActivate(agent2Id, {
          container: { containerId: RUNTIME_ID, runtime: 'local' },
        });
        stateManager.handleCheckin(agent2Id);

        events.length = 0;
        runtime.handleRuntimeDisconnect();

        expect(stateManager.getState(AGENT_ID)?.status).toBe('offline');
        expect(stateManager.getState(agent2Id)?.status).toBe('offline');

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'agent_offline',
            agentId: AGENT_ID,
            reason: 'runtime disconnected',
          })
        );
      });
    });
  });

  describe('workspace path computation', () => {
    it('should compute correct workspace path from agentId', async () => {
      await runtime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      const command = connectionManager._commands.find(
        (c) => (c.command as { type: string }).type === 'activate'
      );

      expect((command?.command as { workspacePath: string }).workspacePath).toBe(
        '/tmp/test-agents/space_123/channel_1/fox'
      );
    });

    it('should use default workspace base path if not configured', async () => {
      const defaultRuntime = createLocalRuntime({
        runtimeId: RUNTIME_ID,
        spaceId: SPACE_ID,
        connectionManager,
        stateManager,
        // No workspaceBasePath
      });

      // Access private field via activate
      connectionManager._commands.length = 0;
      await defaultRuntime.activate({ agentId: AGENT_ID, authToken: 'token_123' });

      const command = connectionManager._commands.find(
        (c) => (c.command as { type: string }).type === 'activate'
      );

      expect((command?.command as { workspacePath: string }).workspacePath).toBe(
        '/tmp/cast-agents/space_123/channel_1/fox'
      );
    });
  });
});
