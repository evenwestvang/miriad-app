import { describe, it, expect, beforeEach } from 'vitest';
import { exec } from './shell.js';
import { createTestContext, createMockSandbox, createMockDaytona } from '../test-helpers.js';
import type { SandboxContext } from '../types.js';

describe('shell handler', () => {
  let ctx: SandboxContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('exec', () => {
    it('executes a command and returns result', async () => {
      const result = await exec(ctx, {
        sandbox: 'test-sandbox',
        command: 'echo hello',
      });

      expect(result.exit_code).toBe(0);
      expect(result.result).toBe('ok');
    });

    it('passes cwd and timeout', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await exec(ctx, {
        sandbox: 'test-sandbox',
        command: 'npm test',
        cwd: '/app',
        timeout: 300,
      });

      expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
        'npm test',
        '/app',
        undefined,
        300,
      );
    });

    it('scrubs secrets from command output', async () => {
      const sandbox = createMockSandbox();
      sandbox.process.executeCommand.mockResolvedValue({
        exitCode: 0,
        result: 'Connected to postgres://secret@host/db',
      });
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await exec(ctx, {
        sandbox: 'test-sandbox',
        command: 'echo $DB_URL',
      });

      expect(result.result).toBe('Connected to [REDACTED]');
    });

    it('rejects access to sandboxes from other channels', async () => {
      const otherSandbox = createMockSandbox({
        labels: { channelId: 'other-channel' },
      });
      const daytona = createMockDaytona(otherSandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(
        exec(ctx, { sandbox: 'other', command: 'ls' }),
      ).rejects.toThrow('not accessible');
    });
  });
});
