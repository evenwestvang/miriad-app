/**
 * Space Seeding Logic
 *
 * Platform-agnostic functions for bootstrapping spaces with default content.
 * Used by both local server startup and AWS Lambda bootstrap handler.
 */

import { ulid } from 'ulid';
import type { BootstrapStorage, SeedResult } from './types.js';
import { getDefaultArtifacts, ROOT_CHANNEL_CONFIG } from './seed-data.js';

export const ROOT_CHANNEL_NAME = 'root';

/**
 * Seed a space with default content.
 * Creates the #root channel and default system artifacts.
 *
 * This is idempotent - skips artifacts that already exist.
 *
 * @param storage - Storage adapter for bootstrap operations
 * @param spaceId - The space to seed
 * @returns Seed result with created/skipped items
 */
export async function seedSpace(
  storage: BootstrapStorage,
  spaceId: string
): Promise<SeedResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Check if root channel already exists
  let rootChannel = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);

  if (!rootChannel) {
    // Create root channel with ULID (globally unique for artifact isolation)
    const rootChannelId = ulid();
    console.log(`[Seed] Creating root channel for space ${spaceId} (id: ${rootChannelId})...`);

    rootChannel = await storage.createChannel(spaceId, {
      id: rootChannelId,
      name: ROOT_CHANNEL_NAME,
      description: ROOT_CHANNEL_CONFIG.description,
      tagline: ROOT_CHANNEL_CONFIG.tagline,
      mission: ROOT_CHANNEL_CONFIG.mission,
    });

    created.push(`channel:${ROOT_CHANNEL_NAME}`);
  } else {
    console.log(`[Seed] Root channel exists for space ${spaceId} (id: ${rootChannel.id})`);
    skipped.push(`channel:${ROOT_CHANNEL_NAME}`);
  }

  const rootChannelId = rootChannel.id;

  // Seed default artifacts
  const defaultArtifacts = getDefaultArtifacts();

  for (const artifactInput of defaultArtifacts) {
    const existing = await storage.getArtifact(spaceId, rootChannelId, artifactInput.slug);

    if (existing) {
      console.log(`[Seed] Artifact "${artifactInput.slug}" already exists, skipping`);
      skipped.push(`artifact:${artifactInput.slug}`);
      continue;
    }

    console.log(`[Seed] Creating artifact "${artifactInput.slug}"...`);
    await storage.createArtifact(spaceId, rootChannelId, {
      ...artifactInput,
      createdBy: 'system',
    });
    created.push(`artifact:${artifactInput.slug}`);
  }

  console.log(`[Seed] Space ${spaceId} seeded: ${created.length} created, ${skipped.length} skipped`);

  return { rootChannelId, created, skipped };
}

/**
 * Bootstrap the system with required channels and artifacts.
 * This is called at server startup to ensure the default space exists.
 *
 * @param storage - Storage adapter for bootstrap operations
 * @param defaultSpaceId - ID for the default space (usually 'default')
 */
export async function bootstrap(
  storage: BootstrapStorage,
  defaultSpaceId: string = 'default'
): Promise<void> {
  // Ensure the default space exists
  const existingSpace = await storage.getSpace(defaultSpaceId);
  if (!existingSpace) {
    await storage.createSpace({
      id: defaultSpaceId,
      ownerId: 'system',
      name: 'Default Space',
    });
    console.log(`[Bootstrap] Default space created (id: ${defaultSpaceId})`);
  } else {
    console.log(`[Bootstrap] Default space exists (id: ${defaultSpaceId})`);
  }

  // Seed the default space
  await seedSpace(storage, defaultSpaceId);

  console.log('[Bootstrap] System bootstrap complete');
}

/**
 * Get the root channel ID for a space.
 * Returns null if the space doesn't have a root channel yet.
 *
 * @param storage - Storage adapter for bootstrap operations
 * @param spaceId - The space to query
 */
export async function getRootChannelId(
  storage: BootstrapStorage,
  spaceId: string
): Promise<string | null> {
  const rootChannel = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);
  return rootChannel?.id ?? null;
}
