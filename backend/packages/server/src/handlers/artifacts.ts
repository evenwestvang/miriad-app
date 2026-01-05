/**
 * Artifact Handlers
 *
 * REST API routes for artifact CRUD operations.
 *
 * Endpoints:
 * - GET    /channels/:channelId/artifacts/tree?pattern=/**  - Tree view (glob)
 * - GET    /channels/:channelId/artifacts                   - List with filters
 * - GET    /channels/:channelId/artifacts/:slug             - Read single artifact
 * - POST   /channels/:channelId/artifacts                   - Create artifact
 * - PATCH  /channels/:channelId/artifacts/:slug             - CAS update
 * - POST   /channels/:channelId/artifacts/:slug/edit        - Surgical content edit
 * - DELETE /channels/:channelId/artifacts/:slug             - Archive (soft delete)
 * - POST   /channels/:channelId/artifacts/:slug/versions    - Create checkpoint
 * - GET    /channels/:channelId/artifacts/:slug/versions    - List versions
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Storage } from '@cast/storage';
import {
  type ArtifactType,
  type ArtifactStatus,
  type ArtifactCASChange,
  isArtifactType,
  isArtifactStatus,
} from '@cast/core';
import type { ConnectionManager } from '../websocket/index.js';

// =============================================================================
// Types
// =============================================================================

export interface ArtifactHandlerOptions {
  /** Storage backend */
  storage: Storage;
  /** Default space ID */
  spaceId: string;
  /** WebSocket connection manager for broadcasts */
  connectionManager: ConnectionManager;
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

const SlugSchema = z.string()
  .min(1, 'Slug is required')
  .regex(/^[a-z0-9-]+(\.[a-z0-9]+)*$/, 'Invalid slug format. Use lowercase letters, numbers, hyphens, and dots for extensions.');

const ArtifactTypeSchema = z.enum([
  'doc',
  'task',
  'code',
  'decision',
  'knowledgebase',
  'system.mcp',
  'system.agent',
  'system.focus',
  'system.playbook',
]);

const ArtifactStatusSchema = z.enum([
  'draft',
  'published',
  'archived',
  'pending',
  'in_progress',
  'done',
  'blocked',
]);

const CreateArtifactSchema = z.object({
  slug: SlugSchema,
  type: ArtifactTypeSchema,
  tldr: z.string().min(1, 'tldr is required'),
  content: z.string(),
  title: z.string().optional(),
  parentSlug: z.string().optional(),
  status: ArtifactStatusSchema.optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  props: z.record(z.unknown()).optional(),
  sender: z.string().min(1, 'sender is required'),
  replace: z.boolean().optional(), // If true, replace existing artifact
});

// Accept both camelCase (oldValue/newValue) and snake_case (old_value/new_value) for flexibility
const CASChangeSchema = z.object({
  field: z.enum(['title', 'tldr', 'status', 'parentSlug', 'assignees', 'labels', 'props']),
  // Support both naming conventions
  old_value: z.unknown().optional(),
  new_value: z.unknown().optional(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
}).transform((data) => ({
  field: data.field,
  // Prefer snake_case, fall back to camelCase
  old_value: data.old_value !== undefined ? data.old_value : data.oldValue,
  new_value: data.new_value !== undefined ? data.new_value : data.newValue,
}));

const CASUpdateSchema = z.object({
  changes: z.array(CASChangeSchema).min(1, 'At least one change is required'),
  sender: z.string().min(1, 'sender is required'),
});

const EditArtifactSchema = z.object({
  old_string: z.string().min(1, 'old_string is required'),
  new_string: z.string(),
  sender: z.string().min(1, 'sender is required'),
});

const CreateVersionSchema = z.object({
  version: z.string().min(1, 'version name is required'),
  message: z.string().optional(),
  sender: z.string().min(1, 'sender is required'),
});

const ListQuerySchema = z.object({
  type: ArtifactTypeSchema.optional(),
  status: ArtifactStatusSchema.optional(),
  assignee: z.string().optional(),
  parentSlug: z.string().optional(),
  search: z.string().optional(),
  regex: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format Zod validation errors for API response.
 */
function formatZodError(error: z.ZodError): { error: string; details: Array<{ path: string; message: string }> } {
  return {
    error: 'validation_error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

/**
 * Broadcast artifact event via Tymbal.
 */
async function broadcastArtifactEvent(
  connectionManager: ConnectionManager,
  channelId: string,
  action: 'create' | 'update' | 'archive',
  artifact: { slug: string; type: string; title?: string; tldr?: string; status: string }
) {
  const frame = JSON.stringify({
    artifact: {
      action,
      channelId,
      payload: artifact,
    },
  });
  await connectionManager.broadcast(channelId, frame);
}

// =============================================================================
// Route Factory
// =============================================================================

export function createArtifactRoutes(options: ArtifactHandlerOptions): Hono {
  const { storage, spaceId, connectionManager } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/tree - Tree view (glob)
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/tree', async (c) => {
    const channelId = c.req.param('channelId');
    const pattern = c.req.query('pattern') || '/**';
    const format = c.req.query('format') || 'json';

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const tree = await storage.globArtifacts(channel.id, pattern);

      if (format === 'text') {
        // Return indented text format for CLI
        type TreeNode = typeof tree[number];
        const formatTree = (nodes: TreeNode[], indent = 0): string => {
          return nodes.map((node: TreeNode) => {
            const prefix = '  '.repeat(indent);
            const typeAnnotation = node.type !== 'doc' ? ` :${node.type}` : '';
            const statusAnnotation = node.type === 'task' ? ` (${node.status})` : '';
            const assigneeAnnotation = node.assignees.length > 0 ? ` @${node.assignees.join(', @')}` : '';
            const line = `${prefix}/${node.slug}${typeAnnotation}${statusAnnotation}${assigneeAnnotation}`;
            const children = node.children.length > 0 ? '\n' + formatTree(node.children, indent + 1) : '';
            return line + children;
          }).join('\n');
        };
        return c.text(formatTree(tree));
      }

      return c.json({ tree });
    } catch (error) {
      console.error('[Artifacts] Error getting tree:', error);
      return c.json({ error: 'Failed to get artifact tree' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts - List artifacts with filters
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts', async (c) => {
    const channelId = c.req.param('channelId');

    // Parse query params
    const query = ListQuerySchema.safeParse({
      type: c.req.query('type'),
      status: c.req.query('status'),
      assignee: c.req.query('assignee'),
      parentSlug: c.req.query('parentSlug'),
      search: c.req.query('search'),
      regex: c.req.query('regex'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    if (!query.success) {
      return c.json(formatZodError(query.error), 400);
    }

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifacts = await storage.listArtifacts(channel.id, {
        type: query.data.type as ArtifactType | undefined,
        status: query.data.status as ArtifactStatus | undefined,
        assignee: query.data.assignee,
        parentSlug: query.data.parentSlug as string | 'root' | undefined,
        search: query.data.search,
        regex: query.data.regex,
        limit: query.data.limit,
        offset: query.data.offset,
      });

      return c.json({ artifacts });
    } catch (error) {
      console.error('[Artifacts] Error listing artifacts:', error);
      return c.json({ error: 'Failed to list artifacts' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug - Read single artifact
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const versionName = c.req.query('version');

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // If version specified, return that specific version
      if (versionName) {
        const version = await storage.getArtifactVersion(channel.id, slug, versionName);
        if (!version) {
          return c.json({ error: `Version '${versionName}' not found for artifact '${slug}'` }, 404);
        }
        return c.json(version);
      }

      // Get current artifact
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // Include version list
      const versions = await storage.listArtifactVersions(channel.id, slug);

      return c.json({
        ...artifact,
        versions: versions.map((v) => ({
          versionName: v.versionName,
          versionMessage: v.versionMessage,
          versionCreatedBy: v.versionCreatedBy,
          versionCreatedAt: v.versionCreatedAt,
        })),
      });
    } catch (error) {
      console.error('[Artifacts] Error reading artifact:', error);
      return c.json({ error: 'Failed to read artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts - Create artifact
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts', async (c) => {
    const channelId = c.req.param('channelId');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CreateArtifactSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { slug, type, tldr, content, title, parentSlug, status, assignees, labels, props, sender, replace } = parsed.data;

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check if artifact already exists
      const existing = await storage.getArtifact(channel.id, slug);

      if (existing && !replace) {
        return c.json({ error: `Artifact already exists: ${slug}. Use replace: true to overwrite.` }, 409);
      }

      if (!existing && replace) {
        return c.json({ error: `Artifact not found: ${slug}. Cannot replace non-existent artifact.` }, 404);
      }

      let artifact;

      if (replace && existing) {
        // Update existing artifact by archiving and recreating
        // For replace mode, we need to use CAS to update all fields
        // But since we're replacing, we'll archive the old one and create new
        await storage.archiveArtifact(channel.id, slug, sender);

        // Create new artifact with same slug
        artifact = await storage.createArtifact(channel.id, {
          slug,
          channelId: channel.id,
          type: type as ArtifactType,
          title,
          tldr,
          content,
          parentSlug,
          status: status as ArtifactStatus | undefined,
          assignees,
          labels,
          props,
          createdBy: sender,
        });
      } else {
        // Create new artifact
        artifact = await storage.createArtifact(channel.id, {
          slug,
          channelId: channel.id,
          type: type as ArtifactType,
          title,
          tldr,
          content,
          parentSlug,
          status: status as ArtifactStatus | undefined,
          assignees,
          labels,
          props,
          createdBy: sender,
        });
      }

      // Broadcast event
      await broadcastArtifactEvent(connectionManager, channel.id, 'create', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });

      return c.json(artifact, 201);
    } catch (error) {
      console.error('[Artifacts] Error creating artifact:', error);
      // Check for unique constraint violation (duplicate slug)
      if (error instanceof Error && error.message.includes('unique')) {
        return c.json({ error: `Artifact already exists: ${slug}` }, 409);
      }
      return c.json({ error: 'Failed to create artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /channels/:channelId/artifacts/:slug - CAS update
  // ---------------------------------------------------------------------------
  app.patch('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CASUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { changes, sender } = parsed.data;

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Convert from API format to storage format
      const storageChanges: ArtifactCASChange[] = changes.map((change) => ({
        field: change.field as ArtifactCASChange['field'],
        oldValue: change.old_value,
        newValue: change.new_value,
      }));

      const result = await storage.updateArtifactWithCAS(channel.id, slug, storageChanges, sender);

      if (!result.success) {
        return c.json({
          error: 'conflict',
          message: 'Value changed since you last read it',
          conflict: result.conflict,
        }, 409);
      }

      // Broadcast event
      if (result.artifact) {
        await broadcastArtifactEvent(connectionManager, channel.id, 'update', {
          slug: result.artifact.slug,
          type: result.artifact.type,
          title: result.artifact.title,
          tldr: result.artifact.tldr,
          status: result.artifact.status,
        });
      }

      return c.json(result.artifact);
    } catch (error) {
      console.error('[Artifacts] Error updating artifact:', error);
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }
      return c.json({ error: 'Failed to update artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts/:slug/edit - Surgical content edit
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts/:slug/edit', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = EditArtifactSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { old_string, new_string, sender } = parsed.data;

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifact = await storage.editArtifact(channel.id, slug, {
        oldString: old_string,
        newString: new_string,
        updatedBy: sender,
      });

      // Broadcast event
      await broadcastArtifactEvent(connectionManager, channel.id, 'update', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });

      return c.json(artifact);
    } catch (error) {
      console.error('[Artifacts] Error editing artifact:', error);
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not found')) {
        if (message.includes('old_string')) {
          return c.json({ error: 'old_string not found in artifact content' }, 404);
        }
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      if (message.includes('ambiguous') || message.includes('multiple')) {
        return c.json({ error: 'old_string matches multiple times - be more specific' }, 409);
      }

      return c.json({ error: 'Failed to edit artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /channels/:channelId/artifacts/:slug - Archive (soft delete)
  // ---------------------------------------------------------------------------
  app.delete('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const sender = c.req.query('sender') || 'system';

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifact = await storage.archiveArtifact(channel.id, slug, sender);

      // Broadcast event
      await broadcastArtifactEvent(connectionManager, channel.id, 'archive', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });

      return c.json({ archived: true, artifact });
    } catch (error) {
      console.error('[Artifacts] Error archiving artifact:', error);
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }
      return c.json({ error: 'Failed to archive artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts/:slug/versions - Create checkpoint
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts/:slug/versions', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { version: versionName, message: versionMessage, sender } = parsed.data;

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const version = await storage.checkpointArtifact(channel.id, slug, {
        versionName,
        versionMessage,
        createdBy: sender,
      });

      return c.json(version, 201);
    } catch (error) {
      console.error('[Artifacts] Error creating version:', error);
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      if (message.includes('already exists') || message.includes('unique')) {
        return c.json({ error: `Version '${versionName}' already exists for this artifact` }, 409);
      }

      return c.json({ error: 'Failed to create version' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug/versions - List versions
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug/versions', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check artifact exists
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      const versions = await storage.listArtifactVersions(channel.id, slug);

      return c.json({ versions });
    } catch (error) {
      console.error('[Artifacts] Error listing versions:', error);
      return c.json({ error: 'Failed to list versions' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug/diff - Diff versions
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug/diff', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const fromVersion = c.req.query('from');
    const toVersion = c.req.query('to');

    if (!fromVersion) {
      return c.json({ error: "'from' query parameter is required" }, 400);
    }

    try {
      // Resolve channel by name or ID
      const channel = await storage.getChannelByName(spaceId, channelId)
        || await storage.getChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const diff = await storage.diffArtifactVersions(
        channel.id,
        slug,
        fromVersion,
        toVersion || undefined
      );

      return c.json({ diff });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      console.error('[Artifacts] Error generating diff:', error);
      return c.json({ error: 'Failed to generate diff' }, 500);
    }
  });

  return app;
}
