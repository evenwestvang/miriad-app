/**
 * Transform Layer
 *
 * Transforms Sanity documents into artifact creation inputs.
 */

import type { CreateArtifactInput } from '@cast/core';
import type {
  SanityAgentTemplate,
  SanityMcpServer,
  SanityPlaybook,
  OnboardingContent,
} from './sanity-client';

/**
 * Artifact input without channelId - added at seeding time.
 */
export type ArtifactSeed = Omit<CreateArtifactInput, 'channelId'>;

// =============================================================================
// Transform MCP Server
// =============================================================================

export function transformMcpServer(mcp: SanityMcpServer): ArtifactSeed {
  // Build props based on transport type
  const props: Record<string, unknown> = {
    transport: mcp.transport,
    capabilities: mcp.capabilities,
  };

  if (mcp.transport === 'stdio') {
    props.command = mcp.command;
    props.args = mcp.args;
    if (mcp.cwd) props.cwd = mcp.cwd;
    if (mcp.env && mcp.env.length > 0) {
      props.env = Object.fromEntries(mcp.env.map((e) => [e.key, e.value]));
    }
  } else if (mcp.transport === 'http') {
    props.url = mcp.url;
    if (mcp.headers && mcp.headers.length > 0) {
      props.headers = Object.fromEntries(mcp.headers.map((h) => [h.key, h.value]));
    }
  }

  return {
    slug: mcp.slug.current,
    type: 'system.mcp',
    title: mcp.name,
    tldr: mcp.capabilities || `MCP server: ${mcp.name}`,
    content: '', // system.mcp stores config in props, not content
    createdBy: 'system',
    status: 'active',
    props,
  };
}

// =============================================================================
// Transform Agent Template
// =============================================================================

export function transformAgentTemplate(
  agent: SanityAgentTemplate,
  mcpLookup: Map<string, SanityMcpServer>
): ArtifactSeed {
  // Resolve MCP references to slugs
  const mcpRefs = (agent.mcpServers || [])
    .map((ref) => {
      const mcp = mcpLookup.get(ref._ref);
      return mcp ? { slug: mcp.slug.current } : null;
    })
    .filter((ref): ref is { slug: string } => ref !== null);

  const props: Record<string, unknown> = {
    engine: agent.engine,
  };

  if (agent.model) props.model = agent.model;
  if (agent.nameTheme) props.nameTheme = agent.nameTheme;
  if (agent.agentName) props.agentName = agent.agentName;
  if (mcpRefs.length > 0) props.mcp = mcpRefs;
  if (agent.featuredChannelStarter) props.featuredChannelStarter = true;

  return {
    slug: agent.slug.current,
    type: 'system.agent',
    title: agent.name,
    tldr: agent.description || `Agent: ${agent.name}`,
    content: agent.systemPrompt || '',
    createdBy: 'system',
    status: 'active',
    props,
  };
}

// =============================================================================
// Transform Playbook
// =============================================================================

export function transformPlaybook(playbook: SanityPlaybook): ArtifactSeed {
  return {
    slug: playbook.slug.current,
    type: 'system.playbook',
    title: playbook.name,
    tldr: playbook.description || `Playbook: ${playbook.name}`,
    content: playbook.content || '',
    createdBy: 'system',
    status: 'active',
    labels: playbook.tags,
  };
}

// =============================================================================
// Transform All Content
// =============================================================================

export interface TransformedContent {
  mcpServers: ArtifactSeed[];
  agentTemplates: ArtifactSeed[];
  playbooks: ArtifactSeed[];
}

/**
 * Transform all Sanity onboarding content to artifact inputs.
 * Only includes content marked as bootstrapped.
 * MCP servers must be transformed first since agents reference them.
 */
export function transformOnboardingContent(
  content: OnboardingContent
): TransformedContent {
  // Filter to only bootstrapped content
  const bootstrappedMcpServers = content.mcpServers.filter((mcp) => mcp.bootstrapped);
  const bootstrappedAgents = content.agentTemplates.filter((agent) => agent.bootstrapped);
  const bootstrappedPlaybooks = content.playbooks.filter((playbook) => playbook.bootstrapped);

  // Build lookup from all MCP servers (agents may reference non-bootstrapped ones)
  const mcpLookup = new Map(content.mcpServers.map((mcp) => [mcp._id, mcp]));

  return {
    mcpServers: bootstrappedMcpServers.map(transformMcpServer),
    agentTemplates: bootstrappedAgents.map((agent) =>
      transformAgentTemplate(agent, mcpLookup)
    ),
    playbooks: bootstrappedPlaybooks.map(transformPlaybook),
  };
}
