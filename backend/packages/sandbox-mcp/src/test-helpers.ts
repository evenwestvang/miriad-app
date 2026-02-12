import { vi } from 'vitest';
import type { SandboxContext } from './types.js';
import { createScrubber } from './scrubber.js';

/**
 * Creates a mock Daytona sandbox with all sub-interfaces.
 */
export function createMockSandbox(overrides: Record<string, any> = {}) {
  return {
    id: 'sandbox-123',
    name: 'test-sandbox',
    state: 'started',
    cpu: 1,
    gpu: 0,
    memory: 1,
    disk: 3,
    labels: { channelId: 'channel-1', spaceId: 'space-1', createdBy: 'sentinel' },
    env: { API_KEY: 'secret-value' },
    autoStopInterval: 30,
    autoArchiveInterval: 10080,
    autoDeleteInterval: 120,
    createdAt: '2026-02-12T00:00:00Z',
    updatedAt: '2026-02-12T00:00:00Z',
    fs: {
      downloadFile: vi.fn().mockResolvedValue(Buffer.from('line1\nline2\nline3')),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn().mockResolvedValue(undefined),
      searchFiles: vi.fn().mockResolvedValue({ files: ['src/index.ts', 'src/app.ts'] }),
      findFiles: vi.fn().mockResolvedValue([
        { file: 'src/index.ts', line: 1, content: 'import foo' },
      ]),
      listFiles: vi.fn().mockResolvedValue([]),
    },
    process: {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: 'ok' }),
    },
    git: {
      clone: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({
        currentBranch: 'main',
        ahead: 0,
        behind: 0,
        branchPublished: true,
        fileStatus: [],
      }),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
      push: vi.fn().mockResolvedValue(undefined),
      branches: vi.fn().mockResolvedValue({ branches: [{ name: 'main', isHead: true }] }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    },
    getSignedPreviewUrl: vi.fn().mockResolvedValue({ url: 'https://preview.daytona.io/abc' }),
    ...overrides,
  };
}

/**
 * Creates a mock Daytona client.
 */
export function createMockDaytona(sandbox = createMockSandbox()) {
  return {
    create: vi.fn().mockResolvedValue(sandbox),
    get: vi.fn().mockResolvedValue(sandbox),
    list: vi.fn().mockResolvedValue({ items: [sandbox] }),
    delete: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a test SandboxContext with mocked Daytona.
 */
export function createTestContext(overrides: Partial<SandboxContext> = {}): SandboxContext {
  const env = { API_KEY: 'secret-value', DB_URL: 'postgres://secret@host/db' };
  return {
    daytona: createMockDaytona() as any,
    channelId: 'channel-1',
    spaceId: 'space-1',
    callsign: 'sentinel',
    env,
    git: { token: 'ghp_test123', username: 'oauth2' },
    scrubber: createScrubber(env),
    ...overrides,
  };
}
