import type { SandboxContext } from '../types.js';
import { ToolError } from '../errors.js';

async function getSandbox(ctx: SandboxContext, sandboxNameOrId: string) {
  const sandbox = await ctx.daytona.get(sandboxNameOrId);
  if (sandbox.labels?.channelId !== ctx.channelId) {
    throw new ToolError('Sandbox not found or not accessible from this channel', 'NOT_FOUND');
  }
  return sandbox;
}

export async function gitClone(ctx: SandboxContext, params: {
  sandbox: string;
  url: string;
  path?: string;
  branch?: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const clonePath = params.path || params.url.split('/').pop()?.replace('.git', '') || 'repo';

  // Git credentials injected server-side from channel environment
  const username = ctx.git.username || 'oauth2';
  const password = ctx.git.token;

  await sandbox.git.clone(
    params.url,
    clonePath,
    params.branch,
    undefined, // commitId
    username,
    password,
  );
  return { path: clonePath, cloned: true };
}

export async function gitStatus(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
}): Promise<{
  current_branch: string;
  ahead: number | undefined;
  behind: number | undefined;
  branch_published: boolean | undefined;
  file_status: Array<{ name: string; extra: string; staging: string; worktree: string }> | undefined;
}> {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const status = await sandbox.git.status(params.path);
  return {
    current_branch: ctx.scrubber.scrub(status.currentBranch || ''),
    ahead: status.ahead,
    behind: status.behind,
    branch_published: status.branchPublished,
    file_status: status.fileStatus as any,
  };
}

export async function gitCommit(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
  message: string;
  author?: string;
  email?: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);

  // Stage all changes first
  await sandbox.git.add(params.path, ['.']);

  const result = await sandbox.git.commit(
    params.path,
    params.message,
    params.author || ctx.callsign,
    params.email || `${ctx.callsign}@miriad.app`,
  );
  return { sha: result.sha };
}

export async function gitPush(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);
  const username = ctx.git.username || 'oauth2';
  const password = ctx.git.token;
  await sandbox.git.push(params.path, username, password);
  return { pushed: true };
}

export async function gitBranch(ctx: SandboxContext, params: {
  sandbox: string;
  path: string;
  action: 'list' | 'create' | 'checkout' | 'delete';
  branch?: string;
}) {
  const sandbox = await getSandbox(ctx, params.sandbox);

  switch (params.action) {
    case 'list': {
      const result = await sandbox.git.branches(params.path);
      return { branches: result.branches };
    }
    case 'create': {
      if (!params.branch) throw new ToolError('branch name required for create', 'INVALID_PARAMS');
      await sandbox.git.createBranch(params.path, params.branch);
      return { branch: params.branch, created: true };
    }
    case 'checkout': {
      if (!params.branch) throw new ToolError('branch name required for checkout', 'INVALID_PARAMS');
      await sandbox.git.checkoutBranch(params.path, params.branch);
      return { branch: params.branch, checked_out: true };
    }
    case 'delete': {
      if (!params.branch) throw new ToolError('branch name required for delete', 'INVALID_PARAMS');
      await sandbox.git.deleteBranch(params.path, params.branch);
      return { branch: params.branch, deleted: true };
    }
    default:
      throw new ToolError(`Unknown action: ${params.action}`, 'INVALID_PARAMS');
  }
}
