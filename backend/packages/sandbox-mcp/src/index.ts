/**
 * @cast/sandbox-mcp — Daytona sandbox tools for Miriad agents.
 *
 * This package provides tool handlers for creating and managing
 * ephemeral Daytona sandboxes. It does NOT run as a standalone server —
 * the server integration layer (@cast/server) wires these tools into
 * the existing MCP delivery path.
 *
 * Usage:
 *   import { getWrappedTools, createSandboxContext, createScrubber } from '@cast/sandbox-mcp';
 *
 *   const ctx = createSandboxContext({ daytona, channelId, spaceId, callsign, env, git });
 *   const tools = getWrappedTools();
 *   // Register tools with MCP server, passing ctx to each handler
 */

export { getWrappedTools, tools } from './tools.js';
export type { ToolDefinition } from './tools.js';
export type { SandboxContext, GitCredentials, SecretScrubber, ToolResult } from './types.js';
export { createScrubber } from './scrubber.js';
export { ToolError, formatError } from './errors.js';

// Re-export Daytona types that consumers need
export type { Daytona, DaytonaConfig } from '@daytonaio/sdk';

import { Daytona } from '@daytonaio/sdk';
import { createScrubber } from './scrubber.js';
import type { SandboxContext, GitCredentials } from './types.js';

/**
 * Create a Daytona client instance from platform config.
 * Called once at server startup.
 */
export function createDaytonaClient(config: {
  apiKey: string;
  apiUrl?: string;
}): Daytona {
  // `target` is a valid runtime param (selects Daytona region) but not in the
  // SDK's DaytonaConfig type definition. Cast needed until SDK types catch up.
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl || 'https://app.daytona.io/api',
    target: 'us',
  } as any);
}

/**
 * Create a SandboxContext for a specific channel request.
 * Called per-request by the server integration layer.
 */
export function createSandboxContext(params: {
  daytona: Daytona;
  channelId: string;
  spaceId: string;
  callsign: string;
  env: Record<string, string>;
  git: GitCredentials;
}): SandboxContext {
  return {
    daytona: params.daytona,
    channelId: params.channelId,
    spaceId: params.spaceId,
    callsign: params.callsign,
    env: params.env,
    git: params.git,
    scrubber: createScrubber(params.env),
  };
}
