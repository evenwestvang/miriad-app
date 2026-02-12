import { describe, it, expect, beforeEach } from 'vitest';
import { create, list, info, deleteSandbox } from './lifecycle.js';
import { createTestContext, createMockSandbox, createMockDaytona } from '../test-helpers.js';
import type { SandboxContext } from '../types.js';

describe('lifecycle handlers', () => {
  let ctx: SandboxContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('create', () => {
    it('creates a sandbox with channel labels and env', async () => {
      const result = await create(ctx, { name: 'test-build' });

      expect(ctx.daytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-build',
          envVars: ctx.env,
          labels: expect.objectContaining({
            channelId: 'channel-1',
            spaceId: 'space-1',
            createdBy: 'sentinel',
          }),
          autoStopInterval: 30,
          autoDeleteInterval: 120,
        }),
      );
      expect(result).toHaveProperty('sandbox_id');
      expect(result).toHaveProperty('name');
    });

    it('includes description in labels', async () => {
      await create(ctx, { name: 'test', description: 'Building PR #42' });

      expect(ctx.daytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: expect.objectContaining({
            description: 'Building PR #42',
          }),
        }),
      );
    });

    it('passes image and resources when specified', async () => {
      await create(ctx, { name: 'test', image: 'node:20', cpu: 2, memory: 4 });

      expect(ctx.daytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'node:20',
          resources: { cpu: 2, memory: 4 },
        }),
      );
    });

    it('uses custom auto-stop interval', async () => {
      await create(ctx, { name: 'test', auto_stop_minutes: 60 });

      expect(ctx.daytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          autoStopInterval: 60,
        }),
      );
    });
  });

  describe('list', () => {
    it('lists sandboxes filtered by channel', async () => {
      const result = await list(ctx, {});

      expect(ctx.daytona.list).toHaveBeenCalledWith({ channelId: 'channel-1' });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('sandbox_id');
    });

    it('filters by state', async () => {
      const stopped = createMockSandbox({ state: 'stopped' });
      const started = createMockSandbox({ state: 'started' });
      const daytona = createMockDaytona();
      daytona.list.mockResolvedValue({ items: [stopped, started] });
      ctx = createTestContext({ daytona: daytona as any });

      const result = await list(ctx, { state: 'started' });
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('started');
    });
  });

  describe('info', () => {
    it('returns detailed sandbox info', async () => {
      const result = await info(ctx, { sandbox: 'test-sandbox' });

      expect(result).toHaveProperty('sandbox_id');
      expect(result).toHaveProperty('env_keys');
      expect(result.env_keys).toContain('API_KEY');
      // env_keys should be key names only, not values
      expect(result).not.toHaveProperty('env');
    });

    it('rejects access to sandboxes from other channels', async () => {
      const otherSandbox = createMockSandbox({
        labels: { channelId: 'other-channel' },
      });
      const daytona = createMockDaytona(otherSandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(info(ctx, { sandbox: 'other' })).rejects.toThrow(
        'not accessible from this channel',
      );
    });
  });

  describe('delete', () => {
    it('deletes a sandbox', async () => {
      const result = await deleteSandbox(ctx, { sandbox: 'test-sandbox' });

      expect(ctx.daytona.delete).toHaveBeenCalled();
      expect(result.deleted).toBe(true);
    });

    it('rejects deletion of sandboxes from other channels', async () => {
      const otherSandbox = createMockSandbox({
        labels: { channelId: 'other-channel' },
      });
      const daytona = createMockDaytona(otherSandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(deleteSandbox(ctx, { sandbox: 'other' })).rejects.toThrow(
        'not accessible from this channel',
      );
    });
  });
});
