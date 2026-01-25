/**
 * Space Seeding
 *
 * Creates default content when a new space is initialized:
 * - #root channel for system configuration
 * - lead agent definition
 * - open focus type
 * - lead agent in roster
 */

import type { Storage } from '@cast/storage';

// =============================================================================
// Lead Agent Definition
// =============================================================================

const LEAD_AGENT_CONTENT = `You coordinate and facilitate work in this space.

## Your Role

As the Lead agent, you:
- Help users understand the project structure and workflow
- Coordinate between team members and agents
- Facilitate decision-making and planning
- Ensure tasks are properly tracked and assigned

## Guidelines

- Keep communication clear and concise
- Focus on unblocking work and maintaining momentum
- Track progress using the board artifacts
- Help new team members get oriented
`;

// =============================================================================
// Open Focus Type Definition
// =============================================================================

const OPEN_FOCUS_CONTENT = `An open-ended focus area for work that doesn't fit a specific template.

## Default Team
- **Lead** — Coordinates and facilitates whatever needs doing

## When to Use
- Exploratory work without a clear structure
- Ad-hoc tasks and conversations
- Projects that don't fit other focus templates
- General collaboration and planning
`;

// =============================================================================
// Seed Function
// =============================================================================

/**
 * Seed a new space with default content.
 *
 * Creates:
 * 1. #root channel for system configuration
 * 2. lead agent definition artifact
 * 3. open focus type artifact
 * 4. lead agent in roster
 *
 * @param storage - Storage instance
 * @param spaceId - ID of the space to seed
 */
export async function seedSpace(storage: Storage, spaceId: string): Promise<void> {
  // 1. Create #root channel
  const rootChannel = await storage.createChannel({
    spaceId,
    name: 'root',
    tagline: 'System configuration',
    mission: 'System-level artifacts and configuration for this space.',
  });

  // 2. Create lead agent definition
  await storage.createArtifact(rootChannel.id, {
    channelId: rootChannel.id,
    slug: 'lead',
    type: 'system.agent',
    title: 'Lead',
    tldr: 'Coordinates and facilitates work',
    content: LEAD_AGENT_CONTENT,
    createdBy: 'system',
    status: 'active',
  });

  // 3. Create open focus type
  await storage.createArtifact(rootChannel.id, {
    channelId: rootChannel.id,
    slug: 'open',
    type: 'system.focus',
    title: 'Open',
    tldr: 'Flexible workspace for any kind of work',
    content: OPEN_FOCUS_CONTENT,
    createdBy: 'system',
    status: 'active',
  });

  // 4. Add lead to roster
  await storage.addToRoster({
    channelId: rootChannel.id,
    callsign: 'lead',
    agentType: 'lead',
  });
}
