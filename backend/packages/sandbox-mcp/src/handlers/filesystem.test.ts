import { describe, it, expect, beforeEach } from 'vitest';
import { read, write, edit, findByGlob, grep } from './filesystem.js';
import { createTestContext, createMockSandbox, createMockDaytona } from '../test-helpers.js';
import type { SandboxContext } from '../types.js';

describe('filesystem handlers', () => {
  let ctx: SandboxContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('read', () => {
    it('reads file content with line numbers', async () => {
      const result = await read(ctx, { sandbox: 'test-sandbox', path: '/app/index.ts' });

      expect(result.content).toBe('line1\nline2\nline3');
      expect(result.total_lines).toBe(3);
      expect(result.offset).toBe(0);
      expect(result.lines_returned).toBe(3);
    });

    it('supports offset and limit', async () => {
      const result = await read(ctx, {
        sandbox: 'test-sandbox',
        path: '/app/index.ts',
        offset: 1,
        limit: 1,
      });

      expect(result.content).toBe('line2');
      expect(result.lines_returned).toBe(1);
      expect(result.offset).toBe(1);
    });

    it('scrubs secrets from file content', async () => {
      const sandbox = createMockSandbox();
      sandbox.fs.downloadFile.mockResolvedValue(
        Buffer.from('config: secret-value'),
      );
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await read(ctx, { sandbox: 'test-sandbox', path: '/config' });
      expect(result.content).toBe('config: [REDACTED]');
    });

    it('rejects access to sandboxes from other channels', async () => {
      const otherSandbox = createMockSandbox({
        labels: { channelId: 'other-channel' },
      });
      const daytona = createMockDaytona(otherSandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(
        read(ctx, { sandbox: 'other', path: '/file' }),
      ).rejects.toThrow('not accessible');
    });
  });

  describe('write', () => {
    it('writes file content', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await write(ctx, {
        sandbox: 'test-sandbox',
        path: '/app/new-file.ts',
        content: 'export const x = 1;',
      });

      expect(result.written).toBe(true);
      expect(sandbox.fs.createFolder).toHaveBeenCalledWith('/app', '755');
      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        '/app/new-file.ts',
      );
    });

    it('skips directory creation for root-level files', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await write(ctx, {
        sandbox: 'test-sandbox',
        path: 'file.txt',
        content: 'hello',
      });

      expect(sandbox.fs.createFolder).not.toHaveBeenCalled();
    });
  });

  describe('edit', () => {
    it('performs surgical find-replace', async () => {
      const sandbox = createMockSandbox();
      sandbox.fs.downloadFile.mockResolvedValue(
        Buffer.from('const x = 1;\nconst y = 2;'),
      );
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await edit(ctx, {
        sandbox: 'test-sandbox',
        path: '/app/index.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      });

      expect(result.edited).toBe(true);
      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('const x = 42;\nconst y = 2;'),
        '/app/index.ts',
      );
    });

    it('rejects when old_string not found', async () => {
      const sandbox = createMockSandbox();
      sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('hello'));
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(
        edit(ctx, {
          sandbox: 'test-sandbox',
          path: '/file',
          old_string: 'not-here',
          new_string: 'replacement',
        }),
      ).rejects.toThrow('not found');
    });

    it('rejects when old_string matches multiple times', async () => {
      const sandbox = createMockSandbox();
      sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('aaa'));
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await expect(
        edit(ctx, {
          sandbox: 'test-sandbox',
          path: '/file',
          old_string: 'a',
          new_string: 'b',
        }),
      ).rejects.toThrow('matches 3 times');
    });
  });

  describe('findByGlob', () => {
    it('searches files by pattern', async () => {
      const result = await findByGlob(ctx, {
        sandbox: 'test-sandbox',
        pattern: '**/*.ts',
      });

      expect(result.files).toEqual(['src/index.ts', 'src/app.ts']);
    });
  });

  describe('grep', () => {
    it('searches file contents', async () => {
      const result = await grep(ctx, {
        sandbox: 'test-sandbox',
        pattern: 'import',
      });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].file).toBe('src/index.ts');
    });

    it('scrubs secrets from grep results', async () => {
      const sandbox = createMockSandbox();
      sandbox.fs.findFiles.mockResolvedValue([
        { file: 'config.ts', line: 1, content: 'key = secret-value' },
      ]);
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await grep(ctx, {
        sandbox: 'test-sandbox',
        pattern: 'key',
      });

      expect(result.matches[0].content).toBe('key = [REDACTED]');
    });
  });
});
