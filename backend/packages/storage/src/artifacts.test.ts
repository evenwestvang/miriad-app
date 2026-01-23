/**
 * Artifact Storage Tests
 *
 * Tests against real PlanetScale database.
 * Set PLANETSCALE_URL environment variable or skip these tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPostgresStorage } from './postgres.js';
import type { Storage } from './interface.js';
import type {
  CreateArtifactInput,
  ArtifactCASChange,
} from '@cast/core';

// Connection string from environment or hardcoded for local dev
const connectionString = process.env.PLANETSCALE_URL ?? buildConnectionString();

function buildConnectionString(): string {
  const host = 'us-east-2.pg.psdb.cloud';
  const port = '6432';
  const user = 'pscale_api_nmney6igy1w2.pwp8x47bv2br';
  const pass = 'pscale_pw_MdmptCQgW99vHwo4MILzUqRPdfn5iNAk';
  const db = 'postgres';
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

// Skip tests if we can't connect to database
const canConnect = await testConnection();

async function testConnection(): Promise<boolean> {
  try {
    const storage = createPostgresStorage({ connectionString });
    await storage.initialize();
    await storage.close();
    return true;
  } catch (err) {
    console.log('⚠️  Skipping Artifact tests: cannot connect to PlanetScale');
    console.log('   Error:', (err as Error).message);
    return false;
  }
}

describe.skipIf(!canConnect)('Artifact Storage', () => {
  let storage: Storage;
  const testRunId = Date.now().toString(36).slice(-8); // Shorter unique suffix
  let testChannelId: string; // Will be set when we create a channel
  const testSpaceId = 'test-space-art'; // 14 chars, fits in space_id
  const createdSlugs: string[] = [];

  // Helper to create unique slugs per test run
  const uniqueSlug = (base: string) => `${base}-${testRunId}`;

  beforeAll(async () => {
    storage = createPostgresStorage({ connectionString });
    await storage.initialize();

    // Create a test channel to get a proper ULID channel_id
    const channel = await storage.createChannel({
      spaceId: testSpaceId,
      name: `artifacts-test-${testRunId}`,
      tagline: 'Artifacts test channel',
    });
    testChannelId = channel.id;
  });

  afterAll(async () => {
    // Clean up test artifacts by archiving them
    for (const slug of createdSlugs) {
      try {
        await storage.archiveArtifact(testChannelId, slug, 'cleanup');
      } catch {
        // Ignore cleanup errors
      }
    }
    // Archive the test channel
    try {
      await storage.archiveChannel(testSpaceId, testChannelId);
    } catch {
      // Ignore cleanup errors
    }
    await storage.close();
  }, 60000); // 60 second timeout for cleanup (PlanetScale can be slow)

  // ===========================================================================
  // Create Tests
  // ===========================================================================

  describe('createArtifact', () => {
    it('should create an artifact with required fields', async () => {
      const slug = uniqueSlug('test-doc');
      const input: CreateArtifactInput = {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'A test document',
        content: '# Test\n\nThis is a test.',
        createdBy: 'arty',
      };

      const artifact = await storage.createArtifact(testChannelId, input);
      createdSlugs.push(slug);

      expect(artifact.id).toBeDefined();
      expect(artifact.id.length).toBe(26); // ULID length
      expect(artifact.slug).toBe(slug);
      expect(artifact.channelId).toBe(testChannelId);
      expect(artifact.type).toBe('doc');
      expect(artifact.tldr).toBe('A test document');
      expect(artifact.content).toBe('# Test\n\nThis is a test.');
      expect(artifact.status).toBe('draft'); // default for doc
      expect(artifact.version).toBe(1);
      expect(artifact.createdBy).toBe('arty');
      expect(artifact.createdAt).toBeDefined();
    });

    it('should create an artifact with optional fields', async () => {
      const slug = uniqueSlug('api-spec');
      const input: CreateArtifactInput = {
        slug,
        channelId: testChannelId,
        type: 'doc',
        title: 'API Specification',
        tldr: 'REST API spec',
        content: '# API\n\n...',
        status: 'active',
        assignees: ['fox', 'bear'],
        labels: ['api', 'backend'],
        createdBy: 'arty',
      };

      const artifact = await storage.createArtifact(testChannelId, input);
      createdSlugs.push(slug);

      expect(artifact.title).toBe('API Specification');
      expect(artifact.status).toBe('active');
      expect(artifact.assignees).toEqual(['fox', 'bear']);
      expect(artifact.labels).toEqual(['api', 'backend']);
    });

    it('should compute nested path from parent', async () => {
      const parentSlug = uniqueSlug('phase-1');
      const childSlug = uniqueSlug('implement-auth');

      // Create parent
      await storage.createArtifact(testChannelId, {
        slug: parentSlug,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Phase 1 tasks',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(parentSlug);

      // Create child
      const child = await storage.createArtifact(testChannelId, {
        slug: childSlug,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Implement authentication',
        content: '',
        parentSlug,
        createdBy: 'arty',
      });
      createdSlugs.push(childSlug);

      // Path should include parent (using ltree format with underscores)
      expect(child.parentSlug).toBe(parentSlug);
      // Path is in ltree format, verify it contains both segments
      expect(child.path).toContain(parentSlug.replace(/-/g, '_'));
    });

    it('should extract refs from content', async () => {
      const slug = uniqueSlug('review-doc');
      const artifact = await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Review document',
        content: 'Based on [[api-spec]] and [[auth-design]].',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      expect(artifact.refs).toEqual(['api-spec', 'auth-design']);
    });

    it('should reject duplicate slug in same channel', async () => {
      const slug = uniqueSlug('unique-slug');

      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'First',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      await expect(
        storage.createArtifact(testChannelId, {
          slug,
          channelId: testChannelId,
          type: 'doc',
          tldr: 'Second',
          content: '',
          createdBy: 'arty',
        })
      ).rejects.toThrow();
    });

    it('should allow same slug in different channels', async () => {
      const slug = uniqueSlug('common-slug');

      // Create another channel
      const otherChannel = await storage.createChannel({
        spaceId: testSpaceId,
        name: `other-channel-${testRunId}`,
      });
      const otherChannelId = otherChannel.id;

      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Channel 1',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const artifact2 = await storage.createArtifact(otherChannelId, {
        slug,
        channelId: otherChannelId,
        type: 'doc',
        tldr: 'Channel 2',
        content: '',
        createdBy: 'arty',
      });

      expect(artifact2.channelId).toBe(otherChannelId);

      // Clean up the other channel's artifact and channel
      await storage.archiveArtifact(otherChannelId, slug, 'cleanup');
      await storage.archiveChannel(testSpaceId, otherChannelId);
    });

    it('should set default status based on type', async () => {
      const taskSlug = uniqueSlug('default-task');
      const task = await storage.createArtifact(testChannelId, {
        slug: taskSlug,
        channelId: testChannelId,
        type: 'task',
        tldr: 'A task',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(taskSlug);

      expect(task.status).toBe('pending'); // default for task
    });
  });

  // ===========================================================================
  // Read Tests
  // ===========================================================================

  describe('getArtifact', () => {
    it('should retrieve an artifact by slug', async () => {
      const slug = uniqueSlug('my-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'My document',
        content: 'Content here',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const artifact = await storage.getArtifact(testChannelId, slug);

      expect(artifact).not.toBeNull();
      expect(artifact!.slug).toBe(slug);
      expect(artifact!.tldr).toBe('My document');
    });

    it('should return null for non-existent artifact', async () => {
      const artifact = await storage.getArtifact(testChannelId, 'non-existent-slug');
      expect(artifact).toBeNull();
    });
  });

  // ===========================================================================
  // CAS Update Tests
  // ===========================================================================

  describe('updateArtifactWithCAS', () => {
    it('should succeed when old values match', async () => {
      const slug = uniqueSlug('cas-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'task',
        tldr: 'CAS test',
        content: '',
        status: 'pending',
        assignees: [],
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const changes: ArtifactCASChange[] = [
        { field: 'status', oldValue: 'pending', newValue: 'in_progress' },
        { field: 'assignees', oldValue: [], newValue: ['fox'] },
      ];

      const result = await storage.updateArtifactWithCAS(testChannelId, slug, changes, 'fox');

      expect(result.success).toBe(true);
      expect(result.artifact!.status).toBe('in_progress');
      expect(result.artifact!.assignees).toEqual(['fox']);
    });

    it('should fail and return conflict when value changed', async () => {
      const slug = uniqueSlug('conflict-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Conflict test',
        content: '',
        status: 'in_progress',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const changes: ArtifactCASChange[] = [
        { field: 'status', oldValue: 'pending', newValue: 'done' },
      ];

      const result = await storage.updateArtifactWithCAS(testChannelId, slug, changes, 'fox');

      expect(result.success).toBe(false);
      expect(result.conflict).toEqual({
        field: 'status',
        expected: 'pending',
        actual: 'in_progress',
      });
    });

    it('should increment version on successful update', async () => {
      const slug = uniqueSlug('version-doc');
      const created = await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Version test',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      expect(created.version).toBe(1);

      const result = await storage.updateArtifactWithCAS(
        testChannelId,
        slug,
        [{ field: 'tldr', oldValue: 'Version test', newValue: 'Updated tldr' }],
        'arty'
      );

      expect(result.success).toBe(true);
      expect(result.artifact!.version).toBe(2);
    });
  });

  // ===========================================================================
  // Edit Tests
  // ===========================================================================

  describe('editArtifact', () => {
    it('should replace content with surgical edit', async () => {
      const slug = uniqueSlug('edit-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Edit test',
        content: 'Hello world! This is a test.',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const edited = await storage.editArtifact(testChannelId, slug, {
        oldString: 'world',
        newString: 'universe',
        updatedBy: 'fox',
      });

      expect(edited.content).toBe('Hello universe! This is a test.');
      expect(edited.updatedBy).toBe('fox');
    });

    it('should throw on not found old string', async () => {
      const slug = uniqueSlug('edit-notfound');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Edit not found test',
        content: 'Some content here',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      await expect(
        storage.editArtifact(testChannelId, slug, {
          oldString: 'nonexistent',
          newString: 'replacement',
          updatedBy: 'fox',
        })
      ).rejects.toThrow();
    });

    it('should throw on ambiguous (multiple matches)', async () => {
      const slug = uniqueSlug('edit-ambiguous');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Ambiguous test',
        content: 'foo foo foo', // 'foo' appears 3 times
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      await expect(
        storage.editArtifact(testChannelId, slug, {
          oldString: 'foo',
          newString: 'bar',
          updatedBy: 'fox',
        })
      ).rejects.toThrow();
    });

    it('should update refs after edit', async () => {
      const slug = uniqueSlug('edit-refs');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Refs edit test',
        content: 'See [[old-ref]] for details.',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const edited = await storage.editArtifact(testChannelId, slug, {
        oldString: '[[old-ref]]',
        newString: '[[new-ref]] and [[another-ref]]',
        updatedBy: 'fox',
      });

      expect(edited.refs).toEqual(['new-ref', 'another-ref']);
    });
  });

  // ===========================================================================
  // Archive Tests
  // ===========================================================================

  describe('archiveArtifact', () => {
    it('should set status to archived', async () => {
      const slug = uniqueSlug('to-archive');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Will be archived',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const archived = await storage.archiveArtifact(testChannelId, slug, 'arty');

      expect(archived.status).toBe('archived');
    });
  });

  // ===========================================================================
  // List Tests
  // ===========================================================================

  describe('listArtifacts', () => {
    const listTestPrefix = `list-test-${testRunId}`;

    beforeAll(async () => {
      // Create test data for list tests
      await storage.createArtifact(testChannelId, {
        slug: `${listTestPrefix}-doc-1`,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Document 1',
        content: 'Content about authentication',
        status: 'active',
        createdBy: 'arty',
      });
      createdSlugs.push(`${listTestPrefix}-doc-1`);

      await storage.createArtifact(testChannelId, {
        slug: `${listTestPrefix}-task-1`,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Task 1',
        content: '',
        status: 'pending',
        assignees: ['fox'],
        createdBy: 'arty',
      });
      createdSlugs.push(`${listTestPrefix}-task-1`);

      await storage.createArtifact(testChannelId, {
        slug: `${listTestPrefix}-task-2`,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Task 2',
        content: '',
        status: 'in_progress',
        assignees: ['bear'],
        createdBy: 'arty',
      });
      createdSlugs.push(`${listTestPrefix}-task-2`);
    });

    it('should list artifacts in channel', async () => {
      const results = await storage.listArtifacts(testChannelId);
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by type', async () => {
      const results = await storage.listArtifacts(testChannelId, { type: 'task' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.type === 'task')).toBe(true);
    });

    it('should filter by status', async () => {
      const results = await storage.listArtifacts(testChannelId, { status: 'pending' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 'pending')).toBe(true);
    });

    it('should filter by assignee', async () => {
      const results = await storage.listArtifacts(testChannelId, { assignee: 'fox' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.slug === `${listTestPrefix}-task-1`)).toBe(true);
    });

    it('should support pagination', async () => {
      const page1 = await storage.listArtifacts(testChannelId, { limit: 2, offset: 0 });
      const page2 = await storage.listArtifacts(testChannelId, { limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBeGreaterThanOrEqual(1);

      // Verify no overlap
      const page1Slugs = page1.map((a) => a.slug);
      const page2Slugs = page2.map((a) => a.slug);
      expect(page1Slugs.some((s) => page2Slugs.includes(s))).toBe(false);
    });

    it('should search with FTS', async () => {
      const results = await storage.listArtifacts(testChannelId, { search: 'authentication' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.slug === `${listTestPrefix}-doc-1`)).toBe(true);
    });
  });

  // ===========================================================================
  // Glob Tests
  // ===========================================================================

  describe('globArtifacts', () => {
    const globTestPrefix = `glob-test-${testRunId}`;

    beforeAll(async () => {
      // Create tree structure
      await storage.createArtifact(testChannelId, {
        slug: `${globTestPrefix}-phase-1`,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Phase 1',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(`${globTestPrefix}-phase-1`);

      await storage.createArtifact(testChannelId, {
        slug: `${globTestPrefix}-auth-task`,
        channelId: testChannelId,
        type: 'task',
        tldr: 'Auth task',
        content: '',
        parentSlug: `${globTestPrefix}-phase-1`,
        createdBy: 'arty',
      });
      createdSlugs.push(`${globTestPrefix}-auth-task`);

      await storage.createArtifact(testChannelId, {
        slug: `${globTestPrefix}-api-task`,
        channelId: testChannelId,
        type: 'task',
        tldr: 'API task',
        content: '',
        parentSlug: `${globTestPrefix}-phase-1`,
        createdBy: 'arty',
      });
      createdSlugs.push(`${globTestPrefix}-api-task`);

      await storage.createArtifact(testChannelId, {
        slug: `${globTestPrefix}-standalone`,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Standalone doc',
        content: '',
        createdBy: 'arty',
      });
      createdSlugs.push(`${globTestPrefix}-standalone`);
    });

    it('should return tree structure with /**', async () => {
      const tree = await storage.globArtifacts(testChannelId, '/**');
      expect(tree.length).toBeGreaterThanOrEqual(2); // At least phase-1 and standalone at root

      // Find the phase-1 node
      const phase1 = tree.find((n) => n.slug === `${globTestPrefix}-phase-1`);
      expect(phase1).toBeDefined();
      expect(phase1!.children.length).toBe(2);
    });

    it('should build correct tree structure', async () => {
      const tree = await storage.globArtifacts(testChannelId, '/**');

      const phase1 = tree.find((n) => n.slug === `${globTestPrefix}-phase-1`)!;
      const childSlugs = phase1.children.map((c) => c.slug).sort();
      expect(childSlugs).toContain(`${globTestPrefix}-api-task`);
      expect(childSlugs).toContain(`${globTestPrefix}-auth-task`);
    });
  });

  // ===========================================================================
  // Version Tests
  // ===========================================================================

  describe('Artifact Versions', () => {
    it('should create a version checkpoint', async () => {
      const slug = uniqueSlug('versioned-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Version 1 tldr',
        content: 'Version 1 content',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      const version = await storage.checkpointArtifact(testChannelId, slug, {
        versionName: 'v1.0',
        versionMessage: 'Initial version',
        createdBy: 'arty',
      });

      expect(version.versionName).toBe('v1.0');
      expect(version.versionMessage).toBe('Initial version');
      expect(version.tldr).toBe('Version 1 tldr');
      expect(version.content).toBe('Version 1 content');
      expect(version.versionCreatedBy).toBe('arty');
    });

    it('should retrieve a specific version', async () => {
      const slug = uniqueSlug('multi-version-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Original',
        content: 'Original content',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      await storage.checkpointArtifact(testChannelId, slug, {
        versionName: 'v1',
        createdBy: 'arty',
      });

      // Update the artifact
      await storage.editArtifact(testChannelId, slug, {
        oldString: 'Original content',
        newString: 'Updated content',
        updatedBy: 'fox',
      });

      // Retrieve the old version
      const v1 = await storage.getArtifactVersion(testChannelId, slug, 'v1');
      expect(v1).not.toBeNull();
      expect(v1!.content).toBe('Original content');

      // Current artifact should have updated content
      const current = await storage.getArtifact(testChannelId, slug);
      expect(current!.content).toBe('Updated content');
    });

    it('should list all versions', async () => {
      const slug = uniqueSlug('list-versions-doc');
      await storage.createArtifact(testChannelId, {
        slug,
        channelId: testChannelId,
        type: 'doc',
        tldr: 'Versioned',
        content: 'Content',
        createdBy: 'arty',
      });
      createdSlugs.push(slug);

      await storage.checkpointArtifact(testChannelId, slug, {
        versionName: 'draft-1',
        createdBy: 'arty',
      });

      await storage.checkpointArtifact(testChannelId, slug, {
        versionName: 'draft-2',
        createdBy: 'arty',
      });

      const versions = await storage.listArtifactVersions(testChannelId, slug);

      expect(versions.length).toBe(2);
      const names = versions.map((v) => v.versionName);
      expect(names).toContain('draft-1');
      expect(names).toContain('draft-2');
    });
  });
});
