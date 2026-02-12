import type { Daytona } from '@daytonaio/sdk';

/**
 * Context passed to every sandbox tool handler.
 * Resolved from the channel bearer token by the server integration layer.
 */
export interface SandboxContext {
  /** Daytona client instance (configured with platform API key) */
  daytona: Daytona;
  /** Channel ID — used for label-based sandbox isolation */
  channelId: string;
  /** Space ID — used for label-based sandbox isolation */
  spaceId: string;
  /** Agent callsign — tagged on sandbox creation */
  callsign: string;
  /** Resolved channel environment (secrets already decrypted) */
  env: Record<string, string>;
  /** Git credentials from channel environment */
  git: GitCredentials;
  /** Secret scrubber — scrubs known secret values from output */
  scrubber: SecretScrubber;
}

export interface GitCredentials {
  token?: string;
  username?: string;
}

/**
 * Scrubs known secret values from text output.
 * Built at sandbox creation time from the injected env values.
 */
export interface SecretScrubber {
  /** Scrub all known secret values from text, replacing with [REDACTED] */
  scrub(text: string): string;
}

/**
 * MCP tool result format.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
