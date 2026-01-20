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

describe('resolveEnvironment', () => {
  it('merges root and channel environments with channel taking precedence', async () => {
    const runtime = createMockRuntime();
    const getEnvironmentArtifacts = vi.fn(async (spaceId: string, channelId: string) => {
      if (channelId === 'root-channel') {
        return [
          {
            slug: 'root-env',
            channelId: 'root-channel',
            props: { variables: { APP_NAME: 'TestApp', LOG_LEVEL: 'debug' } },
            secretKeys: ['API_KEY'],
          },
        ];
      }
      return [
        {
          slug: 'channel-env',
          channelId: 'test-channel',
          props: { variables: { LOG_LEVEL: 'info' } },
          secretKeys: ['API_KEY'],
        },
      ];
    });
    const getRootChannelId = vi.fn(async () => 'root-channel');
    const getSecretValue = vi.fn(async (spaceId: string, channelId: string, slug: string, key: string) => {
      if (channelId === 'root-channel') return 'root-secret-123';
      return 'channel-secret-456';
    });

    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'test-channel', name: 'test' })),
      getRoster: vi.fn(async () => []),
      getEnvironmentArtifacts,
      getRootChannelId,
      getSecretValue,
    };

    const manager = new AgentManager(config);
    const env = await manager.resolveEnvironment('space-1', 'test-channel');

    // APP_NAME from root (not overridden)
    expect(env.APP_NAME).toBe('TestApp');
    // LOG_LEVEL from channel (overrides root's "debug")
    expect(env.LOG_LEVEL).toBe('info');
    // API_KEY from channel (overrides root's secret)
    expect(env.API_KEY).toBe('channel-secret-456');
  });

  it('returns empty object when not configured', async () => {
    const runtime = createMockRuntime();
    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'test-channel', name: 'test' })),
      getRoster: vi.fn(async () => []),
      // No environment config
    };

    const manager = new AgentManager(config);
    const env = await manager.resolveEnvironment('space-1', 'test-channel');

    expect(env).toEqual({});
  });

  it('only uses channel environment when channel is root', async () => {
    const runtime = createMockRuntime();
    const getEnvironmentArtifacts = vi.fn(async () => [
      {
        slug: 'env',
        channelId: 'root-channel',
        props: { variables: { VAR: 'value' } },
        secretKeys: [],
      },
    ]);
    const getRootChannelId = vi.fn(async () => 'root-channel');
    const getSecretValue = vi.fn(async () => null);

    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'root-channel', name: 'root' })),
      getRoster: vi.fn(async () => []),
      getEnvironmentArtifacts,
      getRootChannelId,
      getSecretValue,
    };

    const manager = new AgentManager(config);
    const env = await manager.resolveEnvironment('space-1', 'root-channel');

    expect(env.VAR).toBe('value');
    // Should only call getEnvironmentArtifacts once (for root-channel which IS the channel)
    expect(getEnvironmentArtifacts).toHaveBeenCalledTimes(1);
  });
});

describe('expandMcpConfig', () => {
  it('expands ${VAR} in args, url, headers, and env', async () => {
    const runtime = createMockRuntime();
    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'test-channel', name: 'test' })),
      getRoster: vi.fn(async () => []),
    };

    const manager = new AgentManager(config);

    // Access private method via any cast for testing
    const expandMcpConfig = (manager as any).expandMcpConfig.bind(manager);

    const mcpConfig = {
      name: 'test-mcp',
      transport: 'stdio' as const,
      command: 'echo',
      args: ['${APP_NAME}', '${LOG_LEVEL}'],
      url: 'https://${HOST}/api',
      headers: { Authorization: 'Bearer ${TOKEN}' },
      env: { AUTH: '${API_KEY}', CUSTOM: 'literal' },
    };

    const sharedEnv = {
      APP_NAME: 'TestApp',
      LOG_LEVEL: 'info',
      HOST: 'example.com',
      TOKEN: 'my-token',
      API_KEY: 'secret-key',
    };

    const expanded = expandMcpConfig(mcpConfig, sharedEnv);

    expect(expanded.args).toEqual(['TestApp', 'info']);
    expect(expanded.url).toBe('https://example.com/api');
    expect(expanded.headers).toEqual({ Authorization: 'Bearer my-token' });
    expect(expanded.env).toEqual({ AUTH: 'secret-key', CUSTOM: 'literal' });
  });

  it('MCP own env takes precedence over shared env', async () => {
    const runtime = createMockRuntime();
    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'test-channel', name: 'test' })),
      getRoster: vi.fn(async () => []),
    };

    const manager = new AgentManager(config);
    const expandMcpConfig = (manager as any).expandMcpConfig.bind(manager);

    const mcpConfig = {
      name: 'test-mcp',
      transport: 'stdio' as const,
      command: 'echo',
      args: ['${VAR}'],
      env: { VAR: 'mcp-value', OTHER: '${VAR}' },
    };

    const sharedEnv = { VAR: 'shared-value' };

    const expanded = expandMcpConfig(mcpConfig, sharedEnv);

    // MCP's own VAR takes precedence
    expect(expanded.args).toEqual(['mcp-value']);
    // OTHER references VAR which is mcp-value
    expect(expanded.env?.OTHER).toBe('mcp-value');
  });

  it('replaces unresolved vars with empty string', async () => {
    const runtime = createMockRuntime();
    const config: AgentManagerConfig = {
      runtime,
      broadcast: vi.fn(),
      getChannel: vi.fn(async () => ({ id: 'test-channel', name: 'test' })),
      getRoster: vi.fn(async () => []),
    };

    const manager = new AgentManager(config);
    const expandMcpConfig = (manager as any).expandMcpConfig.bind(manager);

    const mcpConfig = {
      name: 'test-mcp',
      transport: 'stdio' as const,
      command: 'echo',
      args: ['${UNDEFINED_VAR}'],
    };

    const expanded = expandMcpConfig(mcpConfig, {});

    expect(expanded.args).toEqual(['']);
  });
});
