/**
 * Root Channel Reset
 *
 * Deletes all artifacts in the root channel and re-seeds from Sanity.
 * Used for debugging and testing the onboarding/curation flow.
 */

import type { Storage } from '@cast/storage';
import { fetchOnboardingContent } from './sanity-client.js';
import { transformOnboardingContent } from './transform.js';

/**
 * Reset the root channel by deleting all existing artifacts and re-seeding from Sanity.
 *
 * @param storage - Storage instance
 * @param spaceId - ID of the space
 * @returns Summary of what was reset
 */
export async function resetRootChannel(
  storage: Storage,
  spaceId: string
): Promise<{ deletedCount: number; createdCount: number }> {
  // Get the root channel
  const rootChannel = await storage.getChannelByName(spaceId, 'root');
  if (!rootChannel) {
    throw new Error('Root channel not found');
  }

  // Hard delete all artifacts in root channel (including archived ones)
  const deletedCount = await storage.deleteAllArtifactsInChannel(rootChannel.id);

  // Fetch fresh content from Sanity
  const content = await fetchOnboardingContent();
  const transformed = transformOnboardingContent(content);

  let createdCount = 0;

  // Create MCP servers first (agents reference them)
  for (const mcp of transformed.mcpServers) {
    await storage.createArtifact(rootChannel.id, {
      ...mcp,
      channelId: rootChannel.id,
    });
    createdCount++;
  }

  // Create agent templates
  for (const agent of transformed.agentTemplates) {
    await storage.createArtifact(rootChannel.id, {
      ...agent,
      channelId: rootChannel.id,
    });
    createdCount++;
  }

  // Create playbooks
  for (const playbook of transformed.playbooks) {
    await storage.createArtifact(rootChannel.id, {
      ...playbook,
      channelId: rootChannel.id,
    });
    createdCount++;
  }

  return { deletedCount, createdCount };
}
