import type { SandboxContext } from '../types.js';
import { ToolError } from '../errors.js';

export async function tunnel(ctx: SandboxContext, params: {
  sandbox: string;
  port: number;
  expires_in?: number;
}) {
  const sandbox = await ctx.daytona.get(params.sandbox);
  if (sandbox.labels?.channelId !== ctx.channelId) {
    throw new ToolError('Sandbox not found or not accessible from this channel', 'NOT_FOUND');
  }

  const result = await sandbox.getSignedPreviewUrl(params.port, params.expires_in || 3600);
  return { url: result.url, port: params.port };
}
