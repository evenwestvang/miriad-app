import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentManager,
  buildSystemPrompt,
  type AgentManagerConfig,
  type ChannelContext,
  type RosterEntry,
} from './agent-manager.js';
import type { ContainerOrchestrator, ContainerState } from '@cast/runtime';

// =============================================================================
// Mock Container Orchestrator
// =============================================================================

function createMockOrchestrator(): ContainerOrchestrator & {
  spawnCalls: Array<{ spaceId: string; channelId: string; callsign: string }>;
  sendCalls: Array<{ threadId: string; content: string }>;
  stopCalls: Array<{ threadId: string; reason?: string }>;
  runningContainers: Set<string>;
} {
  const spawnCalls: Array<{ spaceId: string; channelId: string; callsign: string }> = [];
  const sendCalls: Array<{ threadId: string; content: string }> = [];
  const stopCalls: Array<{ threadId: string; reason?: string }> = [];
  const runningContainers = new Set<string>();

  return {
    spawnCalls,
    sendCalls,
    stopCalls,
    runningContainers,

    spawn: vi.fn(async (options) => {
      spawnCalls.push({
        spaceId: options.spaceId,
        channelId: options.channelId,
        callsign: options.callsign,
      });
      const threadId = `${options.spaceId}:${options.channelId}:${options.callsign}`;
      runningContainers.add(threadId);
      const state: ContainerState = {
        threadId,
        containerId: `container-${options.callsign}`,
        port: 8081,
        status: 'running',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      return state;
    }),

    sendMessage: vi.fn(async (threadId, content) => {
      sendCalls.push({ threadId, content });
      if (!runningContainers.has(threadId)) {
        throw new Error(`Container not running: ${threadId}`);
      }
    }),

    stop: vi.fn(async (threadId, reason) => {
      stopCalls.push({ threadId, reason });
      runningContainers.delete(threadId);
    }),

    getStatus: vi.fn((threadId) => {
      if (!runningContainers.has(threadId)) return null;
      return {
        threadId,
        containerId: 'mock-container',
        port: 8081,
        status: 'running' as const,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
    }),

    isRunning: vi.fn((threadId) => runningContainers.has(threadId)),

    getAllRunning: vi.fn(() => []),

    shutdown: vi.fn(async () => {
      runningContainers.clear();
    }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('AgentManager', () => {
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let broadcast: ReturnType<typeof vi.fn>;
  let getChannel: ReturnType<typeof vi.fn>;
  let getRoster: ReturnType<typeof vi.fn>;
  let manager: AgentManager;

  const testChannel: ChannelContext = {
    id: 'channel-1',
    name: 'test-channel',
    tagline: 'Test channel tagline',
    mission: 'Test channel mission',
  };

  const testRoster: RosterEntry[] = [
    { callsign: 'agent-1', agentType: 'engineer', status: 'active' },
    { callsign: 'agent-2', agentType: 'researcher', status: 'active' },
  ];

  beforeEach(() => {
    orchestrator = createMockOrchestrator();
    broadcast = vi.fn();
    getChannel = vi.fn(async () => testChannel);
    getRoster = vi.fn(async () => testRoster);

    const config: AgentManagerConfig = {
      orchestrator,
      broadcast,
      getChannel,
      getRoster,
    };

    manager = new AgentManager(config);
  });

  describe('getOrSpawn', () => {
    it('spawns a new agent when not running', async () => {
      const agent = await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      expect(agent.callsign).toBe('agent-1');
      expect(agent.channelId).toBe('channel-1');
      expect(agent.spaceId).toBe('space-1');
      expect(agent.state).toBe('idle');
      expect(orchestrator.spawnCalls).toHaveLength(1);
      expect(orchestrator.spawnCalls[0]).toEqual({
        spaceId: 'space-1',
        channelId: 'channel-1',
        callsign: 'agent-1',
      });
    });

    it('returns existing agent if already running', async () => {
      const agent1 = await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');
      const agent2 = await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      expect(agent1).toBe(agent2);
      expect(orchestrator.spawnCalls).toHaveLength(1);
    });

    it('respawns agent if container died', async () => {
      const agent1 = await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      // Simulate container death
      orchestrator.runningContainers.clear();

      const agent2 = await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawnCalls).toHaveLength(2);
      expect(agent2.state).toBe('idle');
    });

    it('passes system prompt to orchestrator', async () => {
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('#test-channel'),
        })
      );
    });

    it('passes auth token to orchestrator', async () => {
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
        })
      );
    });
  });

  describe('sendMessage', () => {
    it('spawns and sends message to agent', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'user', 'Hello!');

      expect(orchestrator.spawnCalls).toHaveLength(1);
      expect(orchestrator.sendCalls).toHaveLength(1);
      expect(orchestrator.sendCalls[0].content).toContain('Message from @user: Hello!');
    });

    it('formats message with sender context', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'bob', 'Test message');

      expect(orchestrator.sendCalls[0].content).toBe('Message from @bob: Test message');
    });

    it('updates agent state to thinking then idle', async () => {
      const agentPromise = manager.sendMessage('space-1', 'channel-1', 'agent-1', 'user', 'Hi');
      await agentPromise;

      const agent = manager.getStatus('space-1', 'channel-1', 'agent-1');
      expect(agent?.state).toBe('idle');
    });
  });

  describe('stop', () => {
    it('stops a running agent', async () => {
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');
      await manager.stop('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.stopCalls).toHaveLength(1);
      expect(orchestrator.stopCalls[0].threadId).toBe('space-1:channel-1:agent-1');

      const agent = manager.getStatus('space-1', 'channel-1', 'agent-1');
      expect(agent).toBeNull();
    });

    it('does nothing for non-existent agent', async () => {
      await manager.stop('space-1', 'channel-1', 'nonexistent');
      expect(orchestrator.stopCalls).toHaveLength(0);
    });
  });

  describe('getChannelAgents', () => {
    it('returns all agents in a channel', async () => {
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-2');
      await manager.getOrSpawn('space-1', 'channel-2', 'agent-3');

      const agents = manager.getChannelAgents('channel-1');
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.callsign)).toContain('agent-1');
      expect(agents.map((a) => a.callsign)).toContain('agent-2');
    });
  });

  describe('shutdown', () => {
    it('shuts down orchestrator and clears agents', async () => {
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-1');
      await manager.getOrSpawn('space-1', 'channel-1', 'agent-2');

      await manager.shutdown();

      expect(orchestrator.shutdown).toHaveBeenCalled();
      expect(manager.getChannelAgents('channel-1')).toHaveLength(0);
    });
  });
});

describe('buildSystemPrompt', () => {
  it('includes channel context', () => {
    const channel: ChannelContext = {
      id: 'ch-1',
      name: 'dev-team',
      tagline: 'Development workspace',
      mission: 'Build great software',
    };

    const prompt = buildSystemPrompt(channel, [], 'agent-1');

    expect(prompt).toContain('#dev-team');
    expect(prompt).toContain('Development workspace');
    expect(prompt).toContain('Build great software');
  });

  it('includes roster information', () => {
    const channel: ChannelContext = { id: 'ch-1', name: 'test' };
    const roster: RosterEntry[] = [
      { callsign: 'alice', agentType: 'engineer', status: 'active' },
      { callsign: 'bob', agentType: 'researcher', status: 'active' },
    ];

    const prompt = buildSystemPrompt(channel, roster, 'agent-1');

    expect(prompt).toContain('@alice (engineer)');
    expect(prompt).toContain('@bob (researcher)');
  });

  it('includes agent callsign in participation rules', () => {
    const channel: ChannelContext = { id: 'ch-1', name: 'test' };

    const prompt = buildSystemPrompt(channel, [], 'my-agent');

    expect(prompt).toContain('Your callsign is "my-agent"');
  });

  it('includes @mention instructions', () => {
    const channel: ChannelContext = { id: 'ch-1', name: 'test' };

    const prompt = buildSystemPrompt(channel, [], 'agent-1');

    expect(prompt).toContain('@someone');
    expect(prompt).toContain('@channel');
    expect(prompt).toContain('CRITICAL INSTRUCTIONS');
  });
});
