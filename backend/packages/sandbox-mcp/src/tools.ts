import { z } from 'zod';
import type { SandboxContext, ToolResult } from './types.js';
import { formatError } from './errors.js';
import * as lifecycle from './handlers/lifecycle.js';
import * as filesystem from './handlers/filesystem.js';
import * as shell from './handlers/shell.js';
import * as git from './handlers/git.js';
import * as tunnelHandler from './handlers/tunnel.js';

/**
 * Tool definition for the sandbox MCP.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  handler: (ctx: SandboxContext, args: any) => Promise<any>;
}

/**
 * Recursively scrub all string values in an object/array.
 * Operates on raw strings before JSON serialization, so escaped characters
 * (e.g., \n → \\n from JSON.stringify) can't bypass the scrubber regex.
 */
export function deepScrub(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(v => deepScrub(v, scrub));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepScrub(v, scrub);
    }
    return result;
  }
  return value; // numbers, booleans, null — pass through
}

/**
 * Wraps a handler to return MCP tool result format with scrubbed output.
 *
 * Scrubs the result object recursively BEFORE JSON.stringify to prevent
 * bypass via JSON escaping (e.g., newlines in secrets becoming \\n).
 * Handler-level scrubs remain as belt-and-suspenders.
 */
function wrapHandler(
  handler: (ctx: SandboxContext, args: any) => Promise<any>,
): (ctx: SandboxContext, args: any) => Promise<ToolResult> {
  return async (ctx, args) => {
    try {
      const result = await handler(ctx, args);
      const scrubbed = deepScrub(result, ctx.scrubber.scrub);
      const text = JSON.stringify(scrubbed, null, 2);
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      const { error, code } = formatError(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error, code }) }],
        isError: true,
      };
    }
  };
}

// Common schema for sandbox parameter
const sandboxParam = z.string().describe('Sandbox name or ID');

/**
 * All sandbox MCP tool definitions.
 * The server integration layer registers these with the MCP server.
 */
export const tools: ToolDefinition[] = [
  // ── Lifecycle ──
  {
    name: 'create',
    description: 'Create a new sandbox environment. Secrets from the channel environment are automatically injected.',
    schema: z.object({
      name: z.string().describe('Human-readable name for the sandbox (e.g., "build-auth-api-pr42")'),
      description: z.string().optional().describe('What this sandbox is for'),
      image: z.string().optional().describe('Docker/OCI image (default: Daytona default snapshot)'),
      cpu: z.number().optional().describe('CPU cores (default: 1)'),
      memory: z.number().optional().describe('RAM in GiB (default: 1)'),
      disk: z.number().optional().describe('Disk in GiB (default: 3)'),
      auto_stop_minutes: z.number().optional().describe('Auto-stop after idle minutes (default: 30, 0 = disabled)'),
    }),
    handler: lifecycle.create,
  },
  {
    name: 'list',
    description: 'List sandboxes in this channel. Shows name, status, creator, and age.',
    schema: z.object({
      state: z.string().optional().describe('Filter by state (e.g., "started", "stopped")'),
    }),
    handler: lifecycle.list,
  },
  {
    name: 'info',
    description: 'Get detailed info about a sandbox — resources, status, uptime, env key names.',
    schema: z.object({
      sandbox: sandboxParam,
    }),
    handler: lifecycle.info,
  },
  {
    name: 'delete',
    description: 'Delete a sandbox permanently.',
    schema: z.object({
      sandbox: sandboxParam,
    }),
    handler: lifecycle.deleteSandbox,
  },

  // ── File Operations (Nuum parity) ──
  {
    name: 'Read',
    description: 'Read a file from a sandbox. Supports offset/limit for large files.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('File path'),
      offset: z.number().optional().describe('Start line (0-based)'),
      limit: z.number().optional().describe('Max lines to return (default: 2000)'),
    }),
    handler: filesystem.read,
  },
  {
    name: 'Write',
    description: 'Write content to a file in a sandbox. Creates parent directories automatically.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('File path'),
      content: z.string().describe('File content'),
    }),
    handler: filesystem.write,
  },
  {
    name: 'Edit',
    description: 'Surgical find-replace in a file. old_string must match exactly once.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('File path'),
      old_string: z.string().describe('Text to find (must match exactly once)'),
      new_string: z.string().describe('Replacement text'),
    }),
    handler: filesystem.edit,
  },
  {
    name: 'Glob',
    description: 'Find files by name pattern in a sandbox.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().optional().describe('Directory to search (default: working dir)'),
      pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
    }),
    handler: filesystem.findByGlob,
  },
  {
    name: 'Grep',
    description: 'Search file contents for a pattern in a sandbox.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().optional().describe('Directory to search (default: working dir)'),
      pattern: z.string().describe('Search pattern'),
      include: z.string().optional().describe('File pattern filter (e.g., "*.ts")'),
    }),
    handler: filesystem.grep,
  },

  // ── Shell ──
  {
    name: 'exec',
    description: 'Execute a shell command in a sandbox. Returns stdout/stderr.',
    schema: z.object({
      sandbox: sandboxParam,
      command: z.string().describe('Shell command to execute'),
      cwd: z.string().optional().describe('Working directory'),
      timeout: z.number().optional().describe('Timeout in seconds (default: 120)'),
    }),
    handler: shell.exec,
  },

  // ── Git ──
  {
    name: 'git_clone',
    description: 'Clone a repository into a sandbox. Git credentials are injected automatically from the channel environment.',
    schema: z.object({
      sandbox: sandboxParam,
      url: z.string().describe('Repository URL'),
      path: z.string().optional().describe('Clone destination path'),
      branch: z.string().optional().describe('Branch to checkout'),
    }),
    handler: git.gitClone,
  },
  {
    name: 'git_status',
    description: 'Get repository status in a sandbox.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('Repository path'),
    }),
    handler: git.gitStatus,
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit in a sandbox.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('Repository path'),
      message: z.string().describe('Commit message'),
      author: z.string().optional().describe('Author name (default: agent callsign)'),
      email: z.string().optional().describe('Author email (default: callsign@miriad.app)'),
    }),
    handler: git.gitCommit,
  },
  {
    name: 'git_push',
    description: 'Push changes to remote. Git credentials are injected automatically.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('Repository path'),
    }),
    handler: git.gitPush,
  },
  {
    name: 'git_branch',
    description: 'Create, checkout, delete, or list branches.',
    schema: z.object({
      sandbox: sandboxParam,
      path: z.string().describe('Repository path'),
      action: z.enum(['list', 'create', 'checkout', 'delete']).describe('Branch operation'),
      branch: z.string().optional().describe('Branch name (required for create/checkout/delete)'),
    }),
    handler: git.gitBranch,
  },

  // ── Network ──
  {
    name: 'tunnel',
    description: 'Get a public URL for an HTTP service running in the sandbox.',
    schema: z.object({
      sandbox: sandboxParam,
      port: z.number().describe('Port to expose (e.g., 3000)'),
      expires_in: z.number().optional().describe('URL expiry in seconds (default: 3600)'),
    }),
    handler: tunnelHandler.tunnel,
  },
];

/**
 * Get all tool definitions with wrapped handlers (MCP result format + error handling).
 */
export function getWrappedTools(): Array<{
  name: string;
  description: string;
  schema: z.ZodType<any>;
  handler: (ctx: SandboxContext, args: any) => Promise<ToolResult>;
}> {
  return tools.map(t => ({
    ...t,
    handler: wrapHandler(t.handler),
  }));
}
