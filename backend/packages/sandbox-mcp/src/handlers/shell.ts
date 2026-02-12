import type { SandboxContext } from '../types.js';
import { ToolError } from '../errors.js';

export async function exec(ctx: SandboxContext, params: {
  sandbox: string;
  command: string;
  cwd?: string;
  timeout?: number;
}) {
  const sandbox = await ctx.daytona.get(params.sandbox);
  if (sandbox.labels?.channelId !== ctx.channelId) {
    throw new ToolError('Sandbox not found or not accessible from this channel', 'NOT_FOUND');
  }

  const result = await sandbox.process.executeCommand(
    params.command,
    params.cwd,
    undefined, // env — sandbox already has injected env
    params.timeout || 120,
  );

  return {
    exit_code: result.exitCode,
    result: ctx.scrubber.scrub(result.result || ''),
  };
}
