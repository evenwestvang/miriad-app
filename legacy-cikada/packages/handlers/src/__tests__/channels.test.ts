/**
 * Channel Handler Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createChannel,
  getChannel,
  listChannels,
  archiveChannel,
  addAgentToChannel,
  removeAgentFromChannel,
  resolveFocusArea,
  type ChannelStorage,
  type Channel,
  type RosterEntry,
  type ChannelHandlerContext,
} from '../channels/index.js';
import type { ArtifactReader, ArtifactData } from '../agents/index.js';

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(): ChannelStorage & {
  channels: Map<string, Channel>;
  rosters: Map<string, RosterEntry[]>;
  messages: Array<{ spaceId: string; channelId: string; content: string }>;
} {
  const channels = new Map<string, Channel>();
  const rosters = new Map<string, RosterEntry[]>();
  const messages: Array<{ spaceId: string; channelId: string; content: string }> = [];

  return {
    channels,
    rosters,
    messages,

    async createChannel(spaceId, input) {
      const channel: Channel = {
        id: input.id,
        name: input.name,
        description: input.description,
        focusSlug: input.focusSlug,
        tagline: input.tagline,
        mission: input.mission,
        leader: input.leader,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      channels.set(`${spaceId}:${input.id}`, channel);
      return channel;
    },

    async getChannel(spaceId, channelId) {
      return channels.get(`${spaceId}:${channelId}`) ?? null;
    },

    async listChannels(spaceId) {
      return Array.from(channels.values()).filter((ch) =>
        channels.has(`${spaceId}:${ch.id}`)
      );
    },

    async updateChannelStatus(spaceId, channelId, status) {
      const key = `${spaceId}:${channelId}`;
      const channel = channels.get(key);
      if (channel) {
        channels.set(key, { ...channel, status });
      }
    },

    async getRoster(spaceId, channelId) {
      return rosters.get(`${spaceId}:${channelId}`) ?? [];
    },

    async addToRoster(spaceId, channelId, entry) {
      const key = `${spaceId}:${channelId}`;
      const roster = rosters.get(key) ?? [];
      roster.push(entry);
      rosters.set(key, roster);
    },

    async removeFromRoster(spaceId, channelId, participantId) {
      const key = `${spaceId}:${channelId}`;
      const roster = rosters.get(key) ?? [];
      rosters.set(key, roster.filter((e) => e.id !== participantId));
    },

    async saveMessage(spaceId, message) {
      messages.push({ spaceId, channelId: message.channelId, content: message.content });
    },
  };
}

function createMockReader(artifacts: Record<string, Record<string, ArtifactData>>): ArtifactReader {
  return {
    read(channelId: string, slug: string) {
      return artifacts[channelId]?.[slug] ?? null;
    },
  };
}

// =============================================================================
// Focus Area Tests
// =============================================================================

describe('resolveFocusArea', () => {
  it('should resolve focus area from artifact', async () => {
    const reader = createMockReader({
      'root-ch': {
        'open': {
          slug: 'open',
          type: 'system.focus',
          title: 'Open',
          content: 'Open focus area',
          props: {
            agents: ['lead'],
            defaultTagline: 'Open workspace',
            defaultMission: 'Freeform collaboration',
            initialPrompt: 'Welcome!',
            leader: 'lead',
          },
        },
      },
    });

    const focus = await resolveFocusArea(reader, 'root-ch', 'open');

    expect(focus).toEqual({
      tagline: 'Open workspace',
      mission: 'Freeform collaboration',
      agents: ['lead'],
      leader: 'lead',
      initialPrompt: 'Welcome!',
    });
  });

  it('should apply overrides', async () => {
    const reader = createMockReader({
      'root-ch': {
        'open': {
          slug: 'open',
          type: 'system.focus',
          title: 'Open',
          content: '',
          props: {
            defaultTagline: 'Default tagline',
            defaultMission: 'Default mission',
          },
        },
      },
    });

    const focus = await resolveFocusArea(reader, 'root-ch', 'open', {
      tagline: 'Custom tagline',
    });

    expect(focus?.tagline).toBe('Custom tagline');
    expect(focus?.mission).toBe('Default mission');
  });

  it('should return null for missing focus', async () => {
    const reader = createMockReader({});
    const focus = await resolveFocusArea(reader, 'root-ch', 'nonexistent');
    expect(focus).toBeNull();
  });

  it('should return null for non-focus artifacts', async () => {
    const reader = createMockReader({
      'root-ch': {
        'doc': { slug: 'doc', type: 'doc', title: 'Doc', content: '' },
      },
    });
    const focus = await resolveFocusArea(reader, 'root-ch', 'doc');
    expect(focus).toBeNull();
  });
});

// =============================================================================
// Channel Creation Tests
// =============================================================================

describe('createChannel', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let ctx: ChannelHandlerContext;

  beforeEach(() => {
    storage = createMockStorage();
    ctx = { storage, spaceId: 'test-space' };
  });

  it('should create basic channel without focus', async () => {
    const reader = createMockReader({});

    const result = await createChannel(ctx, {
      name: 'test-channel',
      description: 'A test channel',
    }, { artifactReader: reader });

    expect(result.channel.name).toBe('test-channel');
    expect(result.channel.description).toBe('A test channel');
    expect(result.spawnedAgents).toHaveLength(0);
    expect(result.initialPromptPosted).toBe(false);
  });

  it('should create channel with focus area defaults', async () => {
    const reader = createMockReader({
      'root-ch': {
        'open': {
          slug: 'open',
          type: 'system.focus',
          content: '',
          props: {
            defaultTagline: 'Open workspace',
            defaultMission: 'Freeform collaboration',
          },
        },
      },
    });

    const result = await createChannel(ctx, {
      name: 'test-channel',
      focusSlug: 'open',
    }, { artifactReader: reader, rootChannelId: 'root-ch' });

    expect(result.channel.tagline).toBe('Open workspace');
    expect(result.channel.mission).toBe('Freeform collaboration');
  });

  it('should spawn agents from focus definition', async () => {
    const reader = createMockReader({
      'root-ch': {
        'open': {
          slug: 'open',
          type: 'system.focus',
          content: '',
          props: {
            agents: ['lead'],
            leader: 'lead',
          },
        },
        'lead': {
          slug: 'lead',
          type: 'system.agent',
          title: 'Lead',
          content: 'You are the lead.',
          props: {
            engine: 'reactive',
            agentName: 'lead',
          },
        },
      },
    });

    const result = await createChannel(ctx, {
      name: 'test-channel',
      focusSlug: 'open',
    }, { artifactReader: reader, rootChannelId: 'root-ch' });

    expect(result.spawnedAgents).toContain('lead');
    expect(result.channel.leader).toBe('lead');
  });

  it('should post initial prompt', async () => {
    const reader = createMockReader({
      'root-ch': {
        'open': {
          slug: 'open',
          type: 'system.focus',
          content: '',
          props: {
            initialPrompt: 'Welcome to the channel!',
          },
        },
      },
    });

    const result = await createChannel(ctx, {
      name: 'test-channel',
      focusSlug: 'open',
    }, { artifactReader: reader, rootChannelId: 'root-ch' });

    expect(result.initialPromptPosted).toBe(true);
    expect(storage.messages).toHaveLength(1);
    expect(storage.messages[0].content).toBe('Welcome to the channel!');
  });
});

// =============================================================================
// Channel Query Tests
// =============================================================================

describe('getChannel', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let ctx: ChannelHandlerContext;

  beforeEach(() => {
    storage = createMockStorage();
    ctx = { storage, spaceId: 'test-space' };
  });

  it('should return channel with roster', async () => {
    const reader = createMockReader({});
    await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    // Get the created channel ID
    const channels = await listChannels(ctx);
    const channelId = channels[0].id;

    // Add an agent to roster
    await storage.addToRoster('test-space', channelId, {
      id: 'wolf',
      name: 'wolf',
      type: 'agent',
      status: 'online',
      joinedAt: new Date().toISOString(),
    });

    const result = await getChannel(ctx, channelId);

    expect(result?.channel.name).toBe('test-channel');
    expect(result?.roster).toHaveLength(1);
    expect(result?.roster[0].name).toBe('wolf');
  });

  it('should return null for missing channel', async () => {
    const result = await getChannel(ctx, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('archiveChannel', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let ctx: ChannelHandlerContext;

  beforeEach(() => {
    storage = createMockStorage();
    ctx = { storage, spaceId: 'test-space' };
  });

  it('should archive channel', async () => {
    const reader = createMockReader({});
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    await archiveChannel(ctx, channel.id);

    const updated = await storage.getChannel('test-space', channel.id);
    expect(updated?.status).toBe('archived');
  });
});

// =============================================================================
// Roster Management Tests
// =============================================================================

describe('addAgentToChannel', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let ctx: ChannelHandlerContext;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createMockStorage();
    broadcastSpy = vi.fn();
    ctx = { storage, spaceId: 'test-space', broadcast: broadcastSpy };
  });

  it('should add agent to roster', async () => {
    const reader = createMockReader({
      'root-ch': {
        'engineer': {
          slug: 'engineer',
          type: 'system.agent',
          title: 'Engineer',
          content: 'You are an engineer.',
          props: { engine: 'reactive' },
        },
      },
    });

    // Create channel first
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    const result = await addAgentToChannel(ctx, channel.id, {
      agentType: 'engineer',
      callsign: 'fox',
    }, { artifactReader: reader, rootChannelId: 'root-ch' });

    expect(result.entry.name).toBe('fox');
    expect(result.entry.type).toBe('agent');
    expect(result.agentDef?.slug).toBe('engineer');

    // Check broadcast was called
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('should reject duplicate callsigns', async () => {
    const reader = createMockReader({
      'root-ch': {
        'engineer': {
          slug: 'engineer',
          type: 'system.agent',
          title: 'Engineer',
          content: '',
        },
      },
    });

    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    await addAgentToChannel(ctx, channel.id, {
      agentType: 'engineer',
      callsign: 'fox',
    }, { artifactReader: reader, rootChannelId: 'root-ch' });

    await expect(
      addAgentToChannel(ctx, channel.id, {
        agentType: 'engineer',
        callsign: 'fox',
      }, { artifactReader: reader, rootChannelId: 'root-ch' })
    ).rejects.toThrow('already exists');
  });
});

describe('removeAgentFromChannel', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let ctx: ChannelHandlerContext;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createMockStorage();
    broadcastSpy = vi.fn();
    ctx = { storage, spaceId: 'test-space', broadcast: broadcastSpy };
  });

  it('should remove agent from roster', async () => {
    const reader = createMockReader({});
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    // Manually add agents
    await storage.addToRoster('test-space', channel.id, {
      id: 'lead',
      name: 'lead',
      type: 'agent',
      status: 'online',
      joinedAt: new Date().toISOString(),
    });
    await storage.addToRoster('test-space', channel.id, {
      id: 'fox',
      name: 'fox',
      type: 'agent',
      status: 'online',
      joinedAt: new Date().toISOString(),
    });

    await removeAgentFromChannel(ctx, channel.id, 'fox');

    const roster = await storage.getRoster('test-space', channel.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].name).toBe('lead');
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('should protect channel leader by default', async () => {
    const reader = createMockReader({});
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    await storage.addToRoster('test-space', channel.id, {
      id: 'lead',
      name: 'lead',
      type: 'agent',
      status: 'online',
      joinedAt: new Date().toISOString(),
    });

    await expect(
      removeAgentFromChannel(ctx, channel.id, 'lead')
    ).rejects.toThrow('Cannot dismiss the channel leader');
  });

  it('should allow removing leader when protection disabled', async () => {
    const reader = createMockReader({});
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    await storage.addToRoster('test-space', channel.id, {
      id: 'lead',
      name: 'lead',
      type: 'agent',
      status: 'online',
      joinedAt: new Date().toISOString(),
    });

    await removeAgentFromChannel(ctx, channel.id, 'lead', { protectLeader: false });

    const roster = await storage.getRoster('test-space', channel.id);
    expect(roster).toHaveLength(0);
  });

  it('should throw for missing agent', async () => {
    const reader = createMockReader({});
    const { channel } = await createChannel(ctx, { name: 'test-channel' }, { artifactReader: reader });

    await expect(
      removeAgentFromChannel(ctx, channel.id, 'nonexistent')
    ).rejects.toThrow('not found');
  });
});
