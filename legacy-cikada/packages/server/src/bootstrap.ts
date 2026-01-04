/**
 * Bootstrap Module
 *
 * Initializes spaces with default system content.
 *
 * Key concepts:
 * - Each space gets its own #root channel with a unique ULID
 * - System artifacts (focus areas, agent definitions) are seeded into each space's #root
 * - This ensures multi-tenant isolation at the artifact level
 *
 * Storage-agnostic: Uses @cikada/storage interface for artifacts, works with both
 * SQLite (local dev) and DynamoDB (AWS).
 */

import type { Storage } from '@cikada/storage';
import { ulid } from 'ulid';

const ROOT_CHANNEL_NAME = 'root';

// =============================================================================
// Space Seeding
// =============================================================================

export interface SeedSpaceOptions {
  storage: Storage;
}

/**
 * Seed a space with default content.
 * Creates the #root channel and default system artifacts.
 *
 * This should be called:
 * 1. During bootstrap for the default space
 * 2. When a new space is created (first login)
 *
 * @param spaceId - The space to seed
 * @param options - Storage instances
 * @returns The root channel ID for the space
 */
export async function seedSpace(spaceId: string, options: SeedSpaceOptions): Promise<string> {
  const { storage } = options;

  // Check if root channel already exists for this space
  const existingRoot = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);

  if (existingRoot) {
    console.log(`[Seed] Space ${spaceId} already has root channel (id: ${existingRoot.id})`);
    // Still seed artifacts in case some are missing (idempotent)
    await seedDefaultArtifacts(storage, spaceId, existingRoot.id);
    return existingRoot.id;
  }

  // Create root channel with ULID (globally unique for artifact isolation)
  const rootChannelId = ulid();

  console.log(`[Seed] Creating root channel for space ${spaceId} (id: ${rootChannelId})...`);

  await storage.createChannel(spaceId, {
    id: rootChannelId,
    name: ROOT_CHANNEL_NAME,
    description: 'System channel for focus areas, agent definitions, and playbooks',
    tagline: 'System configuration',
    mission: 'Stores system-level artifacts for focus areas, agent definitions, and shared playbooks.',
  });

  // Seed default artifacts
  await seedDefaultArtifacts(storage, spaceId, rootChannelId);

  console.log(`[Seed] Space ${spaceId} seeded successfully`);
  return rootChannelId;
}

/**
 * Seed default system artifacts into a root channel.
 * Uses the Storage interface for compatibility with both SQLite and DynamoDB.
 */
async function seedDefaultArtifacts(storage: Storage, spaceId: string, rootChannelId: string): Promise<void> {
  console.log(`[Seed] Checking artifacts for space ${spaceId} in channel ${rootChannelId}...`);

  // Check if default "open" focus exists
  const openFocus = await storage.getArtifact(spaceId, rootChannelId, 'open');
  console.log(`[Seed] openFocus exists: ${!!openFocus}`);

  if (!openFocus) {
    console.log('[Seed] Creating default "open" focus area...');

    await storage.createArtifact(spaceId, rootChannelId, {
      slug: 'open',
      type: 'system.focus',
      title: 'Open',
      tldr: 'Open-ended focus for freeform work and exploration',
      content: `# Open Focus

An open-ended focus area for work that doesn't fit a specific template.

## Default Team
- **Lead** — Coordinates and facilitates whatever needs doing

## When to Use
- Exploratory work without a clear structure
- Ad-hoc tasks and conversations
- Projects that don't fit other focus templates
- General collaboration and planning`,
      status: 'published',
      createdBy: 'system',
      props: {
        agents: ['lead'],
        defaultTagline: 'Open workspace',
        defaultMission: 'A flexible space for freeform collaboration and exploration.',
      },
    });
  }

  // Check if board-mcp MCP server config exists (provides board tools to reactive agents)
  const boardMcp = await storage.getArtifact(spaceId, rootChannelId, 'board-mcp');
  console.log(`[Seed] boardMcp exists: ${!!boardMcp}`);

  if (!boardMcp) {
    console.log('[Seed] Creating "board-mcp" MCP server config...');

    await storage.createArtifact(spaceId, rootChannelId, {
      slug: 'board-mcp',
      type: 'system.mcp',
      title: 'Board MCP',
      tldr: 'MCP server providing board tools (artifacts, messages) via HTTP transport.',
      content: `This MCP server exposes the Cikada board operations to reactive agents.

Available tools:
- artifact_create, artifact_read, artifact_list, artifact_glob
- artifact_update, artifact_edit, artifact_archive
- message_get, message_search

The URL uses {channelId} placeholder which gets resolved per-channel.`,
      status: 'published',
      createdBy: 'system',
      props: {
        transport: 'http',
        // URL with {channelId} placeholder - resolved at runtime when agent joins a channel
        // Uses CIKADA_API_URL env var (default: http://localhost:3001)
        url: '${CIKADA_API_URL}/mcp/{channelId}',
      },
    });
  }

  // Check if default "lead" agent exists
  const leadAgent = await storage.getArtifact(spaceId, rootChannelId, 'lead');
  console.log(`[Seed] leadAgent exists: ${!!leadAgent}`);

  if (!leadAgent) {
    console.log('[Seed] Creating default "lead" agent definition...');

    await storage.createArtifact(spaceId, rootChannelId, {
      slug: 'lead',
      type: 'system.agent',
      title: 'Lead',
      tldr: 'Main human touchpoint. Coordinates work, assembles teams.',
      content: `You are the Lead agent - the primary coordinator for this channel.

## Your Role
- Coordinate team activities and delegate tasks
- Break down complex work into actionable items
- Track progress and help resolve blockers
- Facilitate communication between team members and humans
- Assemble and direct specialized agents as needed

## Working Style
- Be proactive about organizing work
- Keep humans informed of progress
- Ask clarifying questions when requirements are unclear
- Use the board (artifacts) to track tasks and decisions`,
      status: 'published',
      createdBy: 'system',
      props: {
        engine: 'reactive',
        model: 'claude-sonnet-4-20250514',
        agentName: 'lead',
        mcp: [{ slug: 'board-mcp' }],
      },
    });
  }
}

// =============================================================================
// Bootstrap (Server Startup)
// =============================================================================

/**
 * Bootstrap the system with required channels and artifacts.
 * This is called at server startup to ensure the default space exists.
 */
export async function bootstrap(storage: Storage): Promise<void> {
  const spaceId = 'default';

  // Ensure the default space exists
  const existingSpace = await storage.getSpace(spaceId);
  if (!existingSpace) {
    await storage.createSpace({ id: spaceId, ownerId: 'system', name: 'Default Space' });
    console.log(`[Bootstrap] Default space created (id: ${spaceId})`);
  } else {
    console.log(`[Bootstrap] Default space exists (id: ${spaceId})`);
  }

  // Seed the default space
  await seedSpace(spaceId, { storage });

  console.log('[Bootstrap] System bootstrap complete');
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the root channel ID for a space.
 * Returns null if the space doesn't have a root channel yet.
 */
export async function getRootChannelId(storage: Storage, spaceId: string): Promise<string | null> {
  const rootChannel = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);
  return rootChannel?.id ?? null;
}
