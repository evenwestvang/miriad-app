import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentManager,
  buildSystemPrompt,
  type AgentManagerConfig,
  type ChannelContext,
  type RosterEntry,
  type PromptContext,
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

  describe('spawn', () => {
    it('spawns a new agent', async () => {
      const agent = await manager.spawn('space-1', 'channel-1', 'agent-1');

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

    it('always spawns (no in-memory caching)', async () => {
      // NOTE: Unlike old getOrSpawn, spawn() always spawns a new container
      // Roster callbackUrl is the source of truth - checked in invoker-adapter
      await manager.spawn('space-1', 'channel-1', 'agent-1');
      await manager.spawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawnCalls).toHaveLength(2);
    });

    it('passes system prompt to orchestrator', async () => {
      await manager.spawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('#test-channel'),
        })
      );
    });

    it('passes auth token to orchestrator', async () => {
      await manager.spawn('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
        })
      );
    });
  });

  describe('sendMessage', () => {
    it('spawns container for agent', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'user', 'Hello!');

      // sendMessage now just spawns - the message is delivered via checkin pending queue
      expect(orchestrator.spawnCalls).toHaveLength(1);
      expect(orchestrator.spawnCalls[0]).toEqual({
        spaceId: 'space-1',
        channelId: 'channel-1',
        callsign: 'agent-1',
      });
    });

    it('does not push message directly (message goes via pending queue)', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'bob', 'Test message');

      // No direct sendMessage to orchestrator - container will get message via checkin
      expect(orchestrator.sendCalls).toHaveLength(0);
    });
  });

  describe('stop', () => {
    it('stops a container via orchestrator', async () => {
      await manager.stop('space-1', 'channel-1', 'agent-1');

      expect(orchestrator.stopCalls).toHaveLength(1);
      expect(orchestrator.stopCalls[0].threadId).toBe('space-1:channel-1:agent-1');
    });
  });

  describe('shutdown', () => {
    it('shuts down orchestrator', async () => {
      await manager.shutdown();

      expect(orchestrator.shutdown).toHaveBeenCalled();
    });
  });
});

describe('buildSystemPrompt', () => {
  it('includes channel context', () => {
    const ctx: PromptContext = {
      channel: {
        id: 'ch-1',
        name: 'dev-team',
        tagline: 'Development workspace',
        mission: 'Build great software',
      },
      roster: [],
      callsign: 'agent-1',
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('#dev-team');
    expect(prompt).toContain('Development workspace');
    expect(prompt).toContain('Build great software');
  });

  it('includes roster information', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [
        { callsign: 'alice', agentType: 'engineer', status: 'active' },
        { callsign: 'bob', agentType: 'researcher', status: 'active' },
      ],
      callsign: 'agent-1',
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('@alice (engineer)');
    expect(prompt).toContain('@bob (researcher)');
  });

  it('includes agent callsign in participation rules', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [],
      callsign: 'my-agent',
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('"my-agent"');
  });

  it('includes @mention instructions', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [],
      callsign: 'agent-1',
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('@callsign');
    expect(prompt).toContain('@channel');
  });

  it('includes agent definition content when provided', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [],
      callsign: 'agent-1',
      agentDefinition: {
        slug: 'engineer',
        title: 'Software Engineer',
        content: 'You write production code. Features, fixes, refactors.',
      },
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('Your Role: Software Engineer');
    expect(prompt).toContain('You write production code');
  });

  it('includes focus type instructions when provided', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [],
      callsign: 'agent-1',
      focusType: {
        slug: 'open',
        title: 'Open Workspace',
        content: 'An open-ended focus area for freeform collaboration.',
      },
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('Special Instructions');
    expect(prompt).toContain('open-ended focus area');
  });

  it('includes board collaboration instructions', () => {
    const ctx: PromptContext = {
      channel: { id: 'ch-1', name: 'test' },
      roster: [],
      callsign: 'agent-1',
    };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain('Collaboration Board');
    expect(prompt).toContain('artifact_create');
    expect(prompt).toContain('artifact_update');
  });
});
