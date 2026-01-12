import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentManager,
  buildSystemPrompt,
  type AgentManagerConfig,
  type ChannelContext,
  type RosterEntry,
  type PromptContext,
} from './agent-manager.js';
import { createMockRuntime, type MockAgentRuntime } from '@cast/runtime';

// =============================================================================
// Tests
// =============================================================================

describe('AgentManager', () => {
  let runtime: MockAgentRuntime;
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
    { id: 'r1', callsign: 'agent-1', agentType: 'engineer', status: 'active' },
    { id: 'r2', callsign: 'agent-2', agentType: 'researcher', status: 'active' },
  ];

  beforeEach(() => {
    runtime = createMockRuntime();
    broadcast = vi.fn();
    getChannel = vi.fn(async () => testChannel);
    getRoster = vi.fn(async () => testRoster);

    const config: AgentManagerConfig = {
      runtime,
      broadcast,
      getChannel,
      getRoster,
    };

    manager = new AgentManager(config);
  });

  describe('activate', () => {
    it('activates a new agent', async () => {
      const agent = await manager.activate('space-1', 'channel-1', 'agent-1');

      expect(agent.callsign).toBe('agent-1');
      expect(agent.channelId).toBe('channel-1');
      expect(agent.spaceId).toBe('space-1');
      expect(agent.state).toBe('idle');

      const calls = runtime.getActivateCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].options.agentId).toBe('space-1:channel-1:agent-1');
    });

    it('always activates (no in-memory caching)', async () => {
      // NOTE: Unlike old getOrSpawn, activate() always activates a new container
      // Roster callbackUrl is the source of truth - checked in invoker-adapter
      await manager.activate('space-1', 'channel-1', 'agent-1');
      await manager.activate('space-1', 'channel-1', 'agent-1');

      const calls = runtime.getActivateCalls();
      expect(calls).toHaveLength(2);
    });

    it('passes system prompt to runtime', async () => {
      await manager.activate('space-1', 'channel-1', 'agent-1');

      const calls = runtime.getActivateCalls();
      expect(calls[0].options.systemPrompt).toContain('#test-channel');
    });

    it('passes auth token to runtime', async () => {
      await manager.activate('space-1', 'channel-1', 'agent-1');

      const calls = runtime.getActivateCalls();
      expect(calls[0].options.authToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });
  });

  describe('sendMessage', () => {
    it('activates container for agent', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'user', 'Hello!');

      // sendMessage now just activates - the message is delivered via checkin pending queue
      const calls = runtime.getActivateCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].options.agentId).toBe('space-1:channel-1:agent-1');
    });

    it('does not push message directly (message goes via pending queue)', async () => {
      await manager.sendMessage('space-1', 'channel-1', 'agent-1', 'bob', 'Test message');

      // No direct sendMessage to runtime - container will get message via checkin
      const sendCalls = runtime.getSendMessageCalls();
      expect(sendCalls).toHaveLength(0);
    });
  });

  describe('suspend', () => {
    it('suspends an agent via runtime', async () => {
      // First activate
      await manager.activate('space-1', 'channel-1', 'agent-1');

      // Then suspend
      await manager.suspend('space-1', 'channel-1', 'agent-1');

      const state = runtime.getState('space-1:channel-1:agent-1');
      expect(state?.status).toBe('offline');
    });
  });

  describe('shutdown', () => {
    it('shuts down runtime', async () => {
      // Activate some agents
      await manager.activate('space-1', 'channel-1', 'agent-1');
      await manager.activate('space-1', 'channel-1', 'agent-2');

      await manager.shutdown();

      // All agents should be offline
      expect(runtime.getAllOnline()).toHaveLength(0);
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
        { id: 'r1', callsign: 'alice', agentType: 'engineer', status: 'active' },
        { id: 'r2', callsign: 'bob', agentType: 'researcher', status: 'active' },
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
