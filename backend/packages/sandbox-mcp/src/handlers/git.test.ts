import { describe, it, expect, beforeEach } from 'vitest';
import { gitClone, gitStatus, gitCommit, gitPush, gitBranch } from './git.js';
import { createTestContext, createMockSandbox, createMockDaytona } from '../test-helpers.js';
import type { SandboxContext } from '../types.js';

describe('git handlers', () => {
  let ctx: SandboxContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('gitClone', () => {
    it('clones a repo with channel git credentials', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await gitClone(ctx, {
        sandbox: 'test-sandbox',
        url: 'https://github.com/org/repo.git',
      });

      expect(result.cloned).toBe(true);
      expect(result.path).toBe('repo');
      expect(sandbox.git.clone).toHaveBeenCalledWith(
        'https://github.com/org/repo.git',
        'repo',
        undefined, // branch
        undefined, // commitId
        'oauth2',
        'ghp_test123',
      );
    });

    it('uses custom path and branch', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await gitClone(ctx, {
        sandbox: 'test-sandbox',
        url: 'https://github.com/org/repo.git',
        path: '/workspace/my-repo',
        branch: 'develop',
      });

      expect(sandbox.git.clone).toHaveBeenCalledWith(
        'https://github.com/org/repo.git',
        '/workspace/my-repo',
        'develop',
        undefined,
        'oauth2',
        'ghp_test123',
      );
    });
  });

  describe('gitStatus', () => {
    it('returns repo status', async () => {
      const result = await gitStatus(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
      });

      expect(result.current_branch).toBe('main');
      expect(result.ahead).toBe(0);
    });
  });

  describe('gitCommit', () => {
    it('stages all and commits with agent identity', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await gitCommit(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        message: 'fix: update config',
      });

      expect(result.sha).toBe('abc123');
      expect(sandbox.git.add).toHaveBeenCalledWith('/repo', ['.']);
      expect(sandbox.git.commit).toHaveBeenCalledWith(
        '/repo',
        'fix: update config',
        'sentinel',
        'sentinel@miriad.app',
      );
    });

    it('uses custom author and email', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await gitCommit(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        message: 'test',
        author: 'Custom Author',
        email: 'custom@example.com',
      });

      expect(sandbox.git.commit).toHaveBeenCalledWith(
        '/repo',
        'test',
        'Custom Author',
        'custom@example.com',
      );
    });
  });

  describe('gitPush', () => {
    it('pushes with channel git credentials', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await gitPush(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
      });

      expect(result.pushed).toBe(true);
      expect(sandbox.git.push).toHaveBeenCalledWith(
        '/repo',
        'oauth2',
        'ghp_test123',
      );
    });
  });

  describe('gitBranch', () => {
    it('lists branches', async () => {
      const result = await gitBranch(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        action: 'list',
      });

      expect(result.branches).toBeDefined();
    });

    it('creates a branch', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      const result = await gitBranch(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        action: 'create',
        branch: 'feature/new',
      });

      expect(result.created).toBe(true);
      expect(sandbox.git.createBranch).toHaveBeenCalledWith('/repo', 'feature/new');
    });

    it('rejects create without branch name', async () => {
      await expect(
        gitBranch(ctx, {
          sandbox: 'test-sandbox',
          path: '/repo',
          action: 'create',
        }),
      ).rejects.toThrow('branch name required');
    });

    it('checks out a branch', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await gitBranch(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        action: 'checkout',
        branch: 'develop',
      });

      expect(sandbox.git.checkoutBranch).toHaveBeenCalledWith('/repo', 'develop');
    });

    it('deletes a branch', async () => {
      const sandbox = createMockSandbox();
      const daytona = createMockDaytona(sandbox);
      ctx = createTestContext({ daytona: daytona as any });

      await gitBranch(ctx, {
        sandbox: 'test-sandbox',
        path: '/repo',
        action: 'delete',
        branch: 'old-feature',
      });

      expect(sandbox.git.deleteBranch).toHaveBeenCalledWith('/repo', 'old-feature');
    });
  });
});
