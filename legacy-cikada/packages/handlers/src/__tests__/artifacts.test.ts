/**
 * Artifact Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createArtifact,
  readArtifact,
  listArtifacts,
  globArtifacts,
  updateArtifact,
  updateArtifactCAS,
  archiveArtifact,
  type ArtifactStorage,
  type ChannelVerifier,
  type ArtifactHandlerContext,
  type Artifact,
} from '../index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-123',
    slug: 'test-artifact',
    channelId: 'channel-1',
    type: 'doc',
    title: 'Test Artifact',
    tldr: 'A test artifact',
    content: '# Test Content',
    status: 'published',
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function createMockContext(overrides: Partial<ArtifactHandlerContext> = {}): ArtifactHandlerContext {
  const mockStorage: ArtifactStorage = {
    create: vi.fn().mockReturnValue(createMockArtifact()),
    read: vi.fn().mockReturnValue(createMockArtifact()),
    list: vi.fn().mockReturnValue([createMockArtifact()]),
    glob: vi.fn().mockReturnValue('/test-artifact'),
    update: vi.fn().mockReturnValue(createMockArtifact({ updatedAt: '2026-01-02T00:00:00.000Z' })),
    updateWithCAS: vi.fn().mockReturnValue({ success: true, artifact: createMockArtifact() }),
    archive: vi.fn().mockReturnValue(createMockArtifact({ status: 'archived' })),
  };

  const mockChannelVerifier: ChannelVerifier = {
    verifyChannel: vi.fn().mockReturnValue({ id: 'channel-1', name: 'Test Channel' }),
  };

  const mockBroadcast = vi.fn();

  return {
    storage: mockStorage,
    channelVerifier: mockChannelVerifier,
    broadcast: mockBroadcast,
    spaceId: 'space-1',
    ...overrides,
  };
}

// =============================================================================
// createArtifact Tests
// =============================================================================

describe('createArtifact', () => {
  it('should create an artifact successfully', async () => {
    const ctx = createMockContext();
    const result = await createArtifact(ctx, {
      channelId: 'channel-1',
      input: {
        slug: 'new-artifact',
        type: 'doc',
        tldr: 'A new artifact',
        content: '# New Content',
        createdBy: 'user-1',
      },
    });

    expect(result.status).toBe(201);
    expect((result.body as Artifact).slug).toBe('test-artifact');
    expect(ctx.storage.create).toHaveBeenCalledWith({
      slug: 'new-artifact',
      type: 'doc',
      tldr: 'A new artifact',
      content: '# New Content',
      createdBy: 'user-1',
      channelId: 'channel-1',
    });
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('should return 404 if channel not found', async () => {
    const ctx = createMockContext({
      channelVerifier: { verifyChannel: vi.fn().mockReturnValue(null) },
    });
    const result = await createArtifact(ctx, {
      channelId: 'unknown-channel',
      input: {
        slug: 'test',
        type: 'doc',
        tldr: 'test',
        content: 'test',
        createdBy: 'user-1',
      },
    });

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toBe('Channel not found');
  });

  it('should return 400 if required fields missing', async () => {
    const ctx = createMockContext();
    const result = await createArtifact(ctx, {
      channelId: 'channel-1',
      input: {
        slug: '',
        type: 'doc',
        tldr: 'test',
        content: 'test',
        createdBy: 'user-1',
      },
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('Missing required fields');
  });

  it('should validate props for system.* artifacts', async () => {
    const validateProps = vi.fn().mockReturnValue({ error: 'Invalid props' });
    const ctx = createMockContext({ validateProps });

    const result = await createArtifact(ctx, {
      channelId: 'channel-1',
      input: {
        slug: 'test-agent',
        type: 'system.agent',
        tldr: 'test',
        content: 'test',
        createdBy: 'user-1',
        props: { invalid: true },
      },
    });

    expect(result.status).toBe(400);
    expect(validateProps).toHaveBeenCalledWith('system.agent', { invalid: true });
  });
});

// =============================================================================
// readArtifact Tests
// =============================================================================

describe('readArtifact', () => {
  it('should read an artifact successfully', async () => {
    const ctx = createMockContext();
    const result = await readArtifact(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
    });

    expect(result.status).toBe(200);
    expect((result.body as Artifact).slug).toBe('test-artifact');
    expect(ctx.storage.read).toHaveBeenCalledWith('channel-1', 'test-artifact');
  });

  it('should return 404 if artifact not found', async () => {
    const ctx = createMockContext({
      storage: {
        ...createMockContext().storage,
        read: vi.fn().mockReturnValue(null),
      },
    });
    const result = await readArtifact(ctx, {
      channelId: 'channel-1',
      slug: 'unknown-artifact',
    });

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toContain('Artifact not found');
  });

  it('should return 404 if channel not found', async () => {
    const ctx = createMockContext({
      channelVerifier: { verifyChannel: vi.fn().mockReturnValue(null) },
    });
    const result = await readArtifact(ctx, {
      channelId: 'unknown-channel',
      slug: 'test-artifact',
    });

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toBe('Channel not found');
  });
});

// =============================================================================
// listArtifacts Tests
// =============================================================================

describe('listArtifacts', () => {
  it('should list artifacts successfully', async () => {
    const ctx = createMockContext();
    const result = await listArtifacts(ctx, {
      channelId: 'channel-1',
    });

    expect(result.status).toBe(200);
    expect((result.body as { artifacts: Artifact[] }).artifacts).toHaveLength(1);
    expect(ctx.storage.list).toHaveBeenCalledWith('channel-1', undefined);
  });

  it('should pass filters to storage', async () => {
    const ctx = createMockContext();
    const filters = { type: 'task', status: 'pending', limit: 10 };
    await listArtifacts(ctx, {
      channelId: 'channel-1',
      filters,
    });

    expect(ctx.storage.list).toHaveBeenCalledWith('channel-1', filters);
  });
});

// =============================================================================
// globArtifacts Tests
// =============================================================================

describe('globArtifacts', () => {
  it('should return glob tree', async () => {
    const ctx = createMockContext();
    const result = await globArtifacts(ctx, {
      channelId: 'channel-1',
      pattern: '/**',
    });

    expect(result.status).toBe(200);
    expect((result.body as { tree: string }).tree).toBe('/test-artifact');
    expect(ctx.storage.glob).toHaveBeenCalledWith('channel-1', '/**');
  });
});

// =============================================================================
// updateArtifact Tests
// =============================================================================

describe('updateArtifact', () => {
  it('should update artifact successfully', async () => {
    const ctx = createMockContext();
    const result = await updateArtifact(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      input: { title: 'Updated Title', content: 'Updated content' },
      updatedBy: 'user-2',
    });

    expect(result.status).toBe(200);
    expect(ctx.storage.update).toHaveBeenCalledWith(
      'channel-1',
      'test-artifact',
      { title: 'Updated Title', content: 'Updated content' },
      'user-2'
    );
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('should convert null parentSlug to undefined', async () => {
    const ctx = createMockContext();
    await updateArtifact(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      input: { parentSlug: null },
      updatedBy: 'user-2',
    });

    expect(ctx.storage.update).toHaveBeenCalledWith(
      'channel-1',
      'test-artifact',
      { parentSlug: undefined },
      'user-2'
    );
  });
});

// =============================================================================
// updateArtifactCAS Tests
// =============================================================================

describe('updateArtifactCAS', () => {
  it('should update with CAS successfully', async () => {
    const ctx = createMockContext();
    const changes = [{ field: 'status', oldValue: 'pending', newValue: 'in_progress' }];
    const result = await updateArtifactCAS(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      changes,
      updatedBy: 'user-2',
    });

    expect(result.status).toBe(200);
    expect(ctx.storage.updateWithCAS).toHaveBeenCalledWith(
      'channel-1',
      'test-artifact',
      changes,
      'user-2'
    );
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('should return 409 on CAS conflict', async () => {
    const ctx = createMockContext({
      storage: {
        ...createMockContext().storage,
        updateWithCAS: vi.fn().mockReturnValue({
          success: false,
          conflict: { field: 'status', expected: 'pending', actual: 'done' },
        }),
      },
    });
    const result = await updateArtifactCAS(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      changes: [{ field: 'status', oldValue: 'pending', newValue: 'in_progress' }],
      updatedBy: 'user-2',
    });

    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toBe('CAS conflict');
  });

  it('should validate props changes on system.* artifacts', async () => {
    const validateProps = vi.fn().mockReturnValue({ error: 'Invalid props' });
    const ctx = createMockContext({
      validateProps,
      storage: {
        ...createMockContext().storage,
        read: vi.fn().mockReturnValue(createMockArtifact({ type: 'system.agent' })),
      },
    });

    const result = await updateArtifactCAS(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      changes: [{ field: 'props', newValue: { invalid: true } }],
      updatedBy: 'user-2',
    });

    expect(result.status).toBe(400);
    expect(validateProps).toHaveBeenCalledWith('system.agent', { invalid: true });
  });
});

// =============================================================================
// archiveArtifact Tests
// =============================================================================

describe('archiveArtifact', () => {
  it('should archive artifact successfully', async () => {
    const ctx = createMockContext();
    const result = await archiveArtifact(ctx, {
      channelId: 'channel-1',
      slug: 'test-artifact',
      updatedBy: 'user-2',
    });

    expect(result.status).toBe(200);
    expect((result.body as { archived: boolean }).archived).toBe(true);
    expect(ctx.storage.archive).toHaveBeenCalledWith('channel-1', 'test-artifact', 'user-2');
    expect(ctx.broadcast).toHaveBeenCalled();
  });
});

// =============================================================================
// Async Storage Compatibility Tests
// =============================================================================

describe('async storage compatibility', () => {
  it('should work with async storage implementations', async () => {
    const asyncArtifact = createMockArtifact();
    const ctx = createMockContext({
      storage: {
        create: vi.fn().mockResolvedValue(asyncArtifact),
        read: vi.fn().mockResolvedValue(asyncArtifact),
        list: vi.fn().mockResolvedValue([asyncArtifact]),
        glob: vi.fn().mockResolvedValue('/test'),
        update: vi.fn().mockResolvedValue(asyncArtifact),
        updateWithCAS: vi.fn().mockResolvedValue({ success: true, artifact: asyncArtifact }),
        archive: vi.fn().mockResolvedValue({ ...asyncArtifact, status: 'archived' }),
      },
      channelVerifier: {
        verifyChannel: vi.fn().mockResolvedValue({ id: 'channel-1', name: 'Test' }),
      },
      broadcast: vi.fn().mockResolvedValue(undefined),
    });

    // Test each handler with async storage
    const createResult = await createArtifact(ctx, {
      channelId: 'channel-1',
      input: { slug: 'test', type: 'doc', tldr: 'test', content: 'test', createdBy: 'user' },
    });
    expect(createResult.status).toBe(201);

    const readResult = await readArtifact(ctx, { channelId: 'channel-1', slug: 'test' });
    expect(readResult.status).toBe(200);

    const listResult = await listArtifacts(ctx, { channelId: 'channel-1' });
    expect(listResult.status).toBe(200);

    const globResult = await globArtifacts(ctx, { channelId: 'channel-1', pattern: '/**' });
    expect(globResult.status).toBe(200);
  });
});
