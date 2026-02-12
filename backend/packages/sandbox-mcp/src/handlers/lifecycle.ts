import type { SandboxContext } from '../types.js';
import { ToolError } from '../errors.js';

// Spec defaults
const DEFAULT_AUTO_STOP_MINUTES = 30;
const DEFAULT_AUTO_DELETE_MINUTES = 120;

export async function create(ctx: SandboxContext, params: {
  name: string;
  description?: string;
  image?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  auto_stop_minutes?: number;
}) {
  const labels: Record<string, string> = {
    channelId: ctx.channelId,
    spaceId: ctx.spaceId,
    createdBy: ctx.callsign,
  };
  if (params.description) {
    labels.description = params.description;
  }

  const autoStopInterval = params.auto_stop_minutes ?? DEFAULT_AUTO_STOP_MINUTES;
  const autoDeleteInterval = DEFAULT_AUTO_DELETE_MINUTES;

  const createParams: any = {
    name: params.name,
    envVars: ctx.env,
    labels,
    autoStopInterval,
    autoDeleteInterval,
  };

  if (params.image) {
    createParams.image = params.image;
    const resources: any = {};
    if (params.cpu) resources.cpu = params.cpu;
    if (params.memory) resources.memory = params.memory;
    if (params.disk) resources.disk = params.disk;
    if (Object.keys(resources).length > 0) {
      createParams.resources = resources;
    }
  }

  const sandbox = await ctx.daytona.create(createParams);

  return {
    sandbox_id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    cpu: sandbox.cpu,
    memory: sandbox.memory,
    disk: sandbox.disk,
  };
}

export async function list(ctx: SandboxContext, params: {
  state?: string;
}) {
  const result = await ctx.daytona.list({ channelId: ctx.channelId });

  let items = result.items;
  if (params.state) {
    items = items.filter(s => s.state === params.state);
  }

  return items.map(s => ({
    sandbox_id: s.id,
    name: s.name,
    state: s.state,
    cpu: s.cpu,
    memory: s.memory,
    disk: s.disk,
    labels: s.labels,
    created_at: s.createdAt,
  }));
}

export async function info(ctx: SandboxContext, params: { sandbox: string }) {
  const sandbox = await ctx.daytona.get(params.sandbox);
  assertChannelAccess(sandbox.labels, ctx.channelId);

  return {
    sandbox_id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    cpu: sandbox.cpu,
    gpu: sandbox.gpu,
    memory: sandbox.memory,
    disk: sandbox.disk,
    labels: sandbox.labels,
    env_keys: Object.keys(sandbox.env || {}),
    auto_stop_interval: sandbox.autoStopInterval,
    auto_archive_interval: sandbox.autoArchiveInterval,
    auto_delete_interval: sandbox.autoDeleteInterval,
    created_at: sandbox.createdAt,
    updated_at: sandbox.updatedAt,
  };
}

export async function deleteSandbox(ctx: SandboxContext, params: { sandbox: string }) {
  const sandbox = await ctx.daytona.get(params.sandbox);
  assertChannelAccess(sandbox.labels, ctx.channelId);
  await ctx.daytona.delete(sandbox);
  return { sandbox_id: sandbox.id, deleted: true };
}

/**
 * Verify the sandbox belongs to the requesting channel.
 * Defense in depth — even though list() filters by label,
 * direct get() by name/ID should also be checked.
 */
function assertChannelAccess(labels: Record<string, string>, channelId: string): void {
  if (labels?.channelId !== channelId) {
    throw new ToolError('Sandbox not found or not accessible from this channel', 'NOT_FOUND');
  }
}
