import { describe, it, expect, beforeEach } from 'vitest';
import { tunnel } from './tunnel.js';
import { createTestContext, createMockSandbox, createMockDaytona } from '../test-helpers.js';
import type { SandboxContext } from '../types.js';

describe('tunnel handler', () => {
  let ctx: SandboxContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns a preview URL for a port', async () => {
    const result = await tunnel(ctx, {
      sandbox: 'test-sandbox',
      port: 3000,
    });

    expect(result.url).toBe('https://preview.daytona.io/abc');
    expect(result.port).toBe(3000);
  });

  it('passes custom expiry', async () => {
    const sandbox = createMockSandbox();
    const daytona = createMockDaytona(sandbox);
    ctx = createTestContext({ daytona: daytona as any });

    await tunnel(ctx, {
      sandbox: 'test-sandbox',
      port: 8080,
      expires_in: 7200,
    });

    expect(sandbox.getSignedPreviewUrl).toHaveBeenCalledWith(8080, 7200);
  });

  it('rejects access to sandboxes from other channels', async () => {
    const otherSandbox = createMockSandbox({
      labels: { channelId: 'other-channel' },
    });
    const daytona = createMockDaytona(otherSandbox);
    ctx = createTestContext({ daytona: daytona as any });

    await expect(
      tunnel(ctx, { sandbox: 'other', port: 3000 }),
    ).rejects.toThrow('not accessible');
  });
});
