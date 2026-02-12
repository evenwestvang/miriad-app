import type { SandboxContext } from '../types.js';
import { ToolError } from '../errors.js';

/**
 * Resolve a sandbox by name/ID and verify channel access.
 */
async function getSandbox(ctx: SandboxContext, sandboxNameOrId: string) {
  const sandbox = await ctx.daytona.get(sandboxNameOrId);
  if (sandbox.labels?.channelId !== ctx.channelId) {
    throw new ToolError('Sandbox not found or not accessible from this channel', 'NOT_FOUND');
  }
  return sandbox;
}

export async function read(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
  offset?: number;
  limit?: number;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const buffer = await sandbox.fs.downloadFile(params.path);
  const content = buffer.toString('utf-8');
  const lines = content.split('\n');

  const offset = params.offset || 0;
  const limit = params.limit || 2000;
  const sliced = lines.slice(offset, offset + limit);

  return {
    content: ctx.scrubber.scrub(sliced.join('\n')),
    total_lines: lines.length,
    offset,
    lines_returned: sliced.length,
  };
}

export async function write(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
  content: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);

  // Create parent directories
  const dir = params.path.substring(0, params.path.lastIndexOf('/'));
  if (dir) {
    try {
      await sandbox.fs.createFolder(dir, '755');
    } catch {
      // Directory may already exist
    }
  }

  await sandbox.fs.uploadFile(Buffer.from(params.content, 'utf-8'), params.path);
  return { path: params.path, written: true };
}

export async function edit(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
  old_string: string;
  new_string: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);

  const buffer = await sandbox.fs.downloadFile(params.path);
  const content = buffer.toString('utf-8');

  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) {
    throw new ToolError(`old_string not found in ${params.path}`, 'NOT_FOUND');
  }
  if (occurrences > 1) {
    throw new ToolError(
      `old_string matches ${occurrences} times in ${params.path} — must match exactly once`,
      'AMBIGUOUS_MATCH',
    );
  }

  const newContent = content.replace(params.old_string, params.new_string);
  await sandbox.fs.uploadFile(Buffer.from(newContent, 'utf-8'), params.path);
  return { path: params.path, edited: true };
}

export async function findByGlob(ctx: SandboxContext, params: {
  sandbox: string;
  path?: string;
  pattern: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const searchPath = params.path || '.';
  const result = await sandbox.fs.searchFiles(searchPath, params.pattern);
  return { files: result.files || [] };
}

export async function grep(ctx: SandboxContext, params: {
  sandbox: string;
  path?: string;
  pattern: string;
  include?: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const searchPath = params.path || '.';
  const matches = await sandbox.fs.findFiles(searchPath, params.pattern);

  let filtered = matches;
  if (params.include) {
    const ext = params.include.replace('*', '');
    filtered = matches.filter((m: any) => m.file?.endsWith(ext));
  }

  return {
    matches: filtered.map((m: any) => ({
      file: ctx.scrubber.scrub(m.file || ''),
      line: m.line,
      content: ctx.scrubber.scrub(m.content || ''),
    })),
  };
}
