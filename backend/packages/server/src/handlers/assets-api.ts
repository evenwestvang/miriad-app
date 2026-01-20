/**
 * Assets API Handler (Container Auth)
 *
 * REST API for asset upload/download authenticated via container token.
 * Used by agents running the @miriad-systems/assets-mcp package.
 *
 * Endpoints:
 * - POST /api/assets/:channelId       - Upload asset
 * - GET  /api/assets/:channelId/:slug - Download asset
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import { getMimeType } from '@cast/core';
import { z } from 'zod';
import {
  requireContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from '../auth/container-middleware.js';
import type { AssetStorage } from '../assets/index.js';

// =============================================================================
// Types
// =============================================================================

export interface AssetsApiHandlerOptions {
  storage: Storage;
  assetStorage: AssetStorage;
}

// =============================================================================
// Validation
// =============================================================================

const SlugSchema = z
  .string()
  .min(1, 'Slug is required')
  .regex(
    /^[a-z0-9-]+(\.[a-z0-9]+)*$/,
    'Invalid slug format. Use lowercase letters, numbers, hyphens, and dots for extensions.'
  );

// =============================================================================
// Route Factory
// =============================================================================

export function createAssetsApiRoutes(options: AssetsApiHandlerOptions): Hono<{ Variables: ContainerAuthVariables }> {
  const { storage, assetStorage } = options;

  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Apply container auth to all routes
  app.use('*', requireContainerAuth());

  // ---------------------------------------------------------------------------
  // POST /api/assets/:channelId - Upload asset
  // ---------------------------------------------------------------------------
  app.post('/:channelId', async (c) => {
    const container = getContainerAuth(c);
    const channelIdParam = c.req.param('channelId');

    try {
      // Resolve channel (support both ID and name)
      const channel = await storage.resolveChannel(container.spaceId, channelIdParam);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Verify container has access to this channel
      if (container.channelId !== channel.id) {
        return c.json({ error: 'Access denied - container bound to different channel' }, 403);
      }

      const contentType = c.req.header('Content-Type') || '';

      let slug: string;
      let tldr: string;
      let title: string | undefined;
      let parentSlug: string | undefined;
      let source: { type: 'path'; path: string } | { type: 'base64'; data: string };

      if (contentType.includes('multipart/form-data')) {
        // Handle multipart form upload
        const formData = await c.req.formData();
        const file = formData.get('file') as File | null;
        slug = formData.get('slug') as string;
        tldr = formData.get('tldr') as string;
        title = (formData.get('title') as string) || undefined;
        parentSlug = (formData.get('parentSlug') as string) || undefined;

        if (!file) {
          return c.json({ error: 'Missing file in form data' }, 400);
        }
        if (!slug || !tldr) {
          return c.json({ error: 'Missing required fields: slug, tldr' }, 400);
        }

        // Convert file to base64
        const arrayBuffer = await file.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        source = { type: 'base64', data: base64 };
      } else {
        // Handle JSON body with base64 data
        const body = await c.req.json();
        slug = body.slug;
        tldr = body.tldr;
        title = body.title;
        parentSlug = body.parentSlug;

        if (!slug || !tldr) {
          return c.json({ error: 'Missing required fields: slug, tldr' }, 400);
        }

        if (body.data) {
          source = { type: 'base64', data: body.data };
        } else if (body.path) {
          source = { type: 'path', path: body.path };
        } else {
          return c.json(
            { error: 'Missing file data (provide "data" for base64 or "path" for file path)' },
            400
          );
        }
      }

      // Validate slug format
      const slugValidation = SlugSchema.safeParse(slug);
      if (!slugValidation.success) {
        return c.json({ error: slugValidation.error.errors[0].message }, 400);
      }

      // Save asset to storage
      const result = await assetStorage.saveAsset({
        channelId: channel.id,
        slug,
        source,
      });

      // Create artifact record
      const artifact = await storage.createArtifact(channel.id, {
        slug,
        channelId: channel.id,
        type: 'asset',
        title,
        tldr,
        content: '', // Binary content stored separately
        parentSlug,
        status: 'published',
        contentType: result.contentType,
        fileSize: result.fileSize,
        createdBy: container.callsign,
      });

      return c.json(
        {
          slug: artifact.slug,
          type: artifact.type,
          contentType: result.contentType,
          fileSize: result.fileSize,
          url: `/api/assets/${channelIdParam}/${slug}`,
        },
        201
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('exceeds maximum')) {
          return c.json({ error: error.message }, 413);
        }
        if (error.message.includes('not found')) {
          return c.json({ error: error.message }, 404);
        }
        if (error.message.includes('already exists')) {
          return c.json({ error: error.message }, 409);
        }
      }
      console.error('[Assets API] Error uploading asset:', error);
      return c.json({ error: 'Failed to upload asset' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/assets/:channelId/:slug - Download asset
  // ---------------------------------------------------------------------------
  app.get('/:channelId/:slug', async (c) => {
    const container = getContainerAuth(c);
    const channelIdParam = c.req.param('channelId');
    const slug = c.req.param('slug');

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(container.spaceId, channelIdParam);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Verify container has access to this channel
      if (container.channelId !== channel.id) {
        return c.json({ error: 'Access denied - container bound to different channel' }, 403);
      }

      // Check artifact exists and is an asset
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Asset not found: ${slug}` }, 404);
      }
      if (artifact.type !== 'asset') {
        return c.json({ error: `Not an asset artifact: ${slug}` }, 400);
      }

      const mimeType = artifact.contentType || getMimeType(slug);

      // Use streaming if available (S3 backend) for large files
      if (assetStorage.readAssetStream) {
        const { stream, contentLength, contentType } = await assetStorage.readAssetStream(
          channel.id,
          slug
        );

        const headers: Record<string, string> = {
          'Content-Type': contentType || mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        };

        if (contentLength !== undefined) {
          headers['Content-Length'] = contentLength.toString();
        }

        return new Response(stream, { headers });
      }

      // Fallback to buffered read
      const data = await assetStorage.readAsset(channel.id, slug);

      return new Response(data, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': data.length.toString(),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      console.error('[Assets API] Error serving asset:', error);
      return c.json({ error: 'Failed to serve asset' }, 500);
    }
  });

  return app;
}
