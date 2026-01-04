/**
 * Bootstrap Module Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  seedSpace,
  bootstrap,
  getRootChannelId,
  getDefaultArtifacts,
  ROOT_CHANNEL_NAME,
  ROOT_CHANNEL_CONFIG,
  type BootstrapStorage,
  type ChannelData,
} from '../bootstrap/index.js';

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(): BootstrapStorage & {
  channels: Map<string, Map<string, ChannelData>>;
  artifacts: Map<string, Map<string, { slug: string }>>;
  spaces: Map<string, { id: string }>;
} {
  const channels = new Map<string, Map<string, ChannelData>>();
  const artifacts = new Map<string, Map<string, { slug: string }>>();
  const spaces = new Map<string, { id: string }>();

  return {
    channels,
    artifacts,
    spaces,

    async getChannelByName(spaceId: string, name: string) {
      const spaceChannels = channels.get(spaceId);
      if (!spaceChannels) return null;
      for (const channel of spaceChannels.values()) {
        if (channel.name === name) return channel;
      }
      return null;
    },

    async createChannel(spaceId: string, input) {
      if (!channels.has(spaceId)) {
        channels.set(spaceId, new Map());
      }
      const channel: ChannelData = { id: input.id, name: input.name };
      channels.get(spaceId)!.set(input.id, channel);
      return channel;
    },

    async getArtifact(spaceId: string, channelId: string, slug: string) {
      const key = `${spaceId}:${channelId}`;
      return artifacts.get(key)?.get(slug) ?? null;
    },

    async createArtifact(spaceId: string, channelId: string, input) {
      const key = `${spaceId}:${channelId}`;
      if (!artifacts.has(key)) {
        artifacts.set(key, new Map());
      }
      artifacts.get(key)!.set(input.slug, { slug: input.slug });
    },

    async getSpace(spaceId: string) {
      return spaces.get(spaceId) ?? null;
    },

    async createSpace(input) {
      spaces.set(input.id, { id: input.id });
    },
  };
}

// =============================================================================
// Seed Data Tests
// =============================================================================

describe('getDefaultArtifacts', () => {
  it('should return required system artifacts', () => {
    const artifacts = getDefaultArtifacts();

    expect(artifacts.length).toBeGreaterThanOrEqual(3);

    // Check for open focus
    const openFocus = artifacts.find((a) => a.slug === 'open');
    expect(openFocus).toBeDefined();
    expect(openFocus?.type).toBe('system.focus');
    expect(openFocus?.props?.agents).toContain('lead');

    // Check for board MCP
    const boardMcp = artifacts.find((a) => a.slug === 'board-mcp');
    expect(boardMcp).toBeDefined();
    expect(boardMcp?.type).toBe('system.mcp');
    expect(boardMcp?.props?.transport).toBe('http');

    // Check for lead agent
    const leadAgent = artifacts.find((a) => a.slug === 'lead');
    expect(leadAgent).toBeDefined();
    expect(leadAgent?.type).toBe('system.agent');
    expect(leadAgent?.props?.engine).toBe('reactive');
  });
});

describe('ROOT_CHANNEL_CONFIG', () => {
  it('should have required properties', () => {
    expect(ROOT_CHANNEL_CONFIG.name).toBe('root');
    expect(ROOT_CHANNEL_CONFIG.description).toBeDefined();
    expect(ROOT_CHANNEL_CONFIG.tagline).toBeDefined();
    expect(ROOT_CHANNEL_CONFIG.mission).toBeDefined();
  });
});

// =============================================================================
// Seeding Tests
// =============================================================================

describe('seedSpace', () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should create root channel and all artifacts', async () => {
    const result = await seedSpace(storage, 'test-space');

    expect(result.rootChannelId).toBeDefined();
    expect(result.created).toContain('channel:root');
    expect(result.created).toContain('artifact:open');
    expect(result.created).toContain('artifact:board-mcp');
    expect(result.created).toContain('artifact:lead');
    expect(result.skipped).toHaveLength(0);
  });

  it('should be idempotent - skip existing items', async () => {
    // First seed
    const result1 = await seedSpace(storage, 'test-space');
    expect(result1.created.length).toBeGreaterThan(0);

    // Second seed
    const result2 = await seedSpace(storage, 'test-space');
    expect(result2.created).toHaveLength(0);
    expect(result2.skipped).toContain('channel:root');
    expect(result2.skipped).toContain('artifact:open');
    expect(result2.skipped).toContain('artifact:board-mcp');
    expect(result2.skipped).toContain('artifact:lead');
  });

  it('should return same root channel ID on subsequent calls', async () => {
    const result1 = await seedSpace(storage, 'test-space');
    const result2 = await seedSpace(storage, 'test-space');

    expect(result1.rootChannelId).toBe(result2.rootChannelId);
  });
});

describe('getRootChannelId', () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should return null for unseeded space', async () => {
    const result = await getRootChannelId(storage, 'new-space');
    expect(result).toBeNull();
  });

  it('should return root channel ID for seeded space', async () => {
    const seedResult = await seedSpace(storage, 'test-space');
    const rootId = await getRootChannelId(storage, 'test-space');

    expect(rootId).toBe(seedResult.rootChannelId);
  });
});

describe('bootstrap', () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should create default space and seed it', async () => {
    await bootstrap(storage, 'default');

    // Space should exist
    const space = await storage.getSpace('default');
    expect(space).toBeDefined();

    // Root channel should exist
    const rootId = await getRootChannelId(storage, 'default');
    expect(rootId).toBeDefined();
  });

  it('should be idempotent', async () => {
    await bootstrap(storage, 'default');
    await bootstrap(storage, 'default');

    // Should still have only one space
    expect(storage.spaces.size).toBe(1);

    // Should still have only one root channel for default space
    const spaceChannels = storage.channels.get('default');
    expect(spaceChannels?.size).toBe(1);
  });

  it('should use provided space ID', async () => {
    await bootstrap(storage, 'custom-space');

    const space = await storage.getSpace('custom-space');
    expect(space?.id).toBe('custom-space');
  });
});
