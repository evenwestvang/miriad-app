/**
 * Agent Resolution Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAgentDefinition,
  resolveMcpConfig,
  resolveMcpConfigs,
  resolveEnvVars,
  resolveUrlPlaceholders,
  type ArtifactReader,
  type ArtifactData,
} from '../agents/index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockReader(artifacts: Record<string, Record<string, ArtifactData>>): ArtifactReader {
  return {
    read(channelId: string, slug: string) {
      return artifacts[channelId]?.[slug] ?? null;
    },
  };
}

const mockAgentArtifact: ArtifactData = {
  slug: 'lead',
  type: 'system.agent',
  title: 'Lead Agent',
  content: 'You are the lead agent.',
  props: {
    engine: 'reactive',
    model: 'claude-sonnet-4-20250514',
    agentName: 'lead',
    mcp: [{ slug: 'board-mcp' }],
  },
};

const mockMcpArtifact: ArtifactData = {
  slug: 'board-mcp',
  type: 'system.mcp',
  title: 'Board MCP',
  content: 'MCP server for board tools.',
  props: {
    transport: 'http',
    url: '${CIKADA_API_URL}/mcp/{channelId}',
  },
};

const mockStdioMcpArtifact: ArtifactData = {
  slug: 'fs-mcp',
  type: 'system.mcp',
  title: 'Filesystem MCP',
  content: 'MCP server for filesystem access.',
  props: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { HOME: '${HOME}' },
  },
};

// =============================================================================
// Environment Variable Resolution Tests
// =============================================================================

describe('resolveEnvVars', () => {
  it('should resolve known env vars with defaults', () => {
    const result = resolveEnvVars('${CIKADA_API_URL}/test');
    expect(result).toBe('http://localhost:3001/test');
  });

  it('should keep unresolvable placeholders', () => {
    const result = resolveEnvVars('${UNKNOWN_VAR}/test');
    expect(result).toBe('${UNKNOWN_VAR}/test');
  });

  it('should use custom env defaults', () => {
    const result = resolveEnvVars('${CUSTOM_VAR}/test', {
      envDefaults: { CUSTOM_VAR: 'custom-value' },
    });
    expect(result).toBe('custom-value/test');
  });

  it('should use custom getEnv function', () => {
    const result = resolveEnvVars('${MY_VAR}/test', {
      getEnv: (name) => (name === 'MY_VAR' ? 'from-getter' : undefined),
    });
    expect(result).toBe('from-getter/test');
  });
});

describe('resolveUrlPlaceholders', () => {
  it('should resolve channelId placeholder', () => {
    const result = resolveUrlPlaceholders('http://api/mcp/{channelId}', 'ch-123');
    expect(result).toBe('http://api/mcp/ch-123');
  });

  it('should resolve both env vars and channelId', () => {
    const result = resolveUrlPlaceholders('${CIKADA_API_URL}/mcp/{channelId}', 'ch-456');
    expect(result).toBe('http://localhost:3001/mcp/ch-456');
  });
});

// =============================================================================
// Agent Definition Resolution Tests
// =============================================================================

describe('resolveAgentDefinition', () => {
  it('should resolve agent from channel', async () => {
    const reader = createMockReader({
      'ch-1': { lead: mockAgentArtifact },
    });

    const result = await resolveAgentDefinition(reader, 'ch-1', 'lead');

    expect(result).toEqual({
      slug: 'lead',
      name: 'Lead Agent',
      content: 'You are the lead agent.',
      engine: 'reactive',
      model: 'claude-sonnet-4-20250514',
      agentName: 'lead',
      mcp: [{ slug: 'board-mcp' }],
    });
  });

  it('should fall back to root channel', async () => {
    const reader = createMockReader({
      'root-ch': { lead: mockAgentArtifact },
    });

    const result = await resolveAgentDefinition(reader, 'ch-1', 'lead', {
      rootChannelId: 'root-ch',
    });

    expect(result).toBeDefined();
    expect(result?.slug).toBe('lead');
  });

  it('should prefer channel-local over root', async () => {
    const localAgent: ArtifactData = {
      ...mockAgentArtifact,
      content: 'Channel-specific prompt.',
    };

    const reader = createMockReader({
      'ch-1': { lead: localAgent },
      'root-ch': { lead: mockAgentArtifact },
    });

    const result = await resolveAgentDefinition(reader, 'ch-1', 'lead', {
      rootChannelId: 'root-ch',
    });

    expect(result?.content).toBe('Channel-specific prompt.');
  });

  it('should return undefined for non-agent artifacts', async () => {
    const reader = createMockReader({
      'ch-1': { lead: { ...mockAgentArtifact, type: 'doc' } },
    });

    const result = await resolveAgentDefinition(reader, 'ch-1', 'lead');

    expect(result).toBeUndefined();
  });

  it('should return undefined for missing artifacts', async () => {
    const reader = createMockReader({});

    const result = await resolveAgentDefinition(reader, 'ch-1', 'nonexistent');

    expect(result).toBeUndefined();
  });

  it('should work with async readers', async () => {
    const reader: ArtifactReader = {
      read: async (channelId, slug) => {
        await new Promise((r) => setTimeout(r, 10)); // Simulate async
        if (channelId === 'ch-1' && slug === 'lead') {
          return mockAgentArtifact;
        }
        return null;
      },
    };

    const result = await resolveAgentDefinition(reader, 'ch-1', 'lead');

    expect(result?.slug).toBe('lead');
  });
});

// =============================================================================
// MCP Config Resolution Tests
// =============================================================================

describe('resolveMcpConfig', () => {
  it('should resolve HTTP MCP config with URL placeholders', async () => {
    const reader = createMockReader({
      'ch-1': { 'board-mcp': mockMcpArtifact },
    });

    const result = await resolveMcpConfig(reader, 'ch-1', 'board-mcp');

    expect(result).toEqual({
      name: 'board-mcp',
      slug: 'board-mcp',
      transport: 'http',
      url: 'http://localhost:3001/mcp/ch-1',
      capabilities: undefined,
    });
  });

  it('should resolve stdio MCP config with env vars', async () => {
    const reader = createMockReader({
      'ch-1': { 'fs-mcp': mockStdioMcpArtifact },
    });

    const result = await resolveMcpConfig(reader, 'ch-1', 'fs-mcp', {
      getEnv: (name) => (name === 'HOME' ? '/Users/test' : undefined),
    });

    expect(result).toEqual({
      name: 'fs-mcp',
      slug: 'fs-mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { HOME: '/Users/test' },
      capabilities: undefined,
    });
  });

  it('should fall back to root channel', async () => {
    const reader = createMockReader({
      'root-ch': { 'board-mcp': mockMcpArtifact },
    });

    const result = await resolveMcpConfig(reader, 'ch-1', 'board-mcp', {
      rootChannelId: 'root-ch',
    });

    expect(result).toBeDefined();
    expect(result?.slug).toBe('board-mcp');
  });

  it('should return undefined for non-mcp artifacts', async () => {
    const reader = createMockReader({
      'ch-1': { 'board-mcp': { ...mockMcpArtifact, type: 'doc' } },
    });

    const result = await resolveMcpConfig(reader, 'ch-1', 'board-mcp');

    expect(result).toBeUndefined();
  });
});

describe('resolveMcpConfigs', () => {
  it('should resolve multiple MCP configs', async () => {
    const reader = createMockReader({
      'ch-1': {
        'board-mcp': mockMcpArtifact,
        'fs-mcp': mockStdioMcpArtifact,
      },
    });

    const result = await resolveMcpConfigs(
      reader,
      'ch-1',
      [{ slug: 'board-mcp' }, { slug: 'fs-mcp' }],
    );

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('board-mcp');
    expect(result[1].slug).toBe('fs-mcp');
  });

  it('should skip missing MCP configs', async () => {
    const reader = createMockReader({
      'ch-1': { 'board-mcp': mockMcpArtifact },
    });

    const result = await resolveMcpConfigs(
      reader,
      'ch-1',
      [{ slug: 'board-mcp' }, { slug: 'nonexistent' }],
    );

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('board-mcp');
  });
});
