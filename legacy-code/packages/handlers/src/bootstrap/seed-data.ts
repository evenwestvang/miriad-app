/**
 * Default Seed Data
 *
 * Canonical definitions for system artifacts seeded into new spaces.
 * Single source of truth for both local dev and AWS.
 */

import type { SeedArtifactInput } from './types.js';

/**
 * Get the default system artifacts to seed into a root channel.
 * These are shared between local dev and AWS deployments.
 */
export function getDefaultArtifacts(): SeedArtifactInput[] {
  return [
    // Open focus area - default workspace type
    {
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
      props: {
        agents: ['lead'],
        defaultTagline: 'Open workspace',
        defaultMission: 'A flexible space for freeform collaboration and exploration.',
      },
    },

    // Board MCP server config - provides board tools to reactive agents
    {
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
      props: {
        transport: 'http',
        // URL with {channelId} placeholder - resolved at runtime when agent joins a channel
        // Uses CIKADA_API_URL env var (default: http://localhost:3001)
        url: '${CIKADA_API_URL}/mcp/{channelId}',
      },
    },

    // Lead agent definition - primary coordinator
    {
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
      props: {
        engine: 'reactive',
        model: 'claude-sonnet-4-20250514',
        agentName: 'lead',
        mcp: [{ slug: 'board-mcp' }],
      },
    },
  ];
}

/**
 * Root channel configuration
 */
export const ROOT_CHANNEL_CONFIG = {
  name: 'root',
  description: 'System channel for focus areas, agent definitions, and playbooks',
  tagline: 'System configuration',
  mission: 'Stores system-level artifacts for focus areas, agent definitions, and shared playbooks.',
} as const;
