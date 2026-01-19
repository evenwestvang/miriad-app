/**
 * Runtime Routes
 *
 * REST API routes for local runtime management.
 *
 * Endpoints:
 * - GET  /api/spaces/:spaceId/runtimes       - List runtimes for space
 * - GET  /api/spaces/:spaceId/runtimes/:id   - Get runtime details
 * - DELETE /api/spaces/:spaceId/runtimes/:id - Delete runtime
 *
 * Space Secrets:
 * - PUT    /api/spaces/:spaceId/secrets/:key - Set a secret
 * - DELETE /api/spaces/:spaceId/secrets/:key - Delete a secret
 * - GET    /api/spaces/:spaceId/secrets      - List secrets (metadata only)
 *
 * All endpoints require authentication and space membership verification.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Storage } from '@cast/storage';
import { parseSession } from '../auth/index.js';

// =============================================================================
// Schemas
// =============================================================================

const SetSecretSchema = z.object({
  value: z.string().min(1, 'value is required'),
  expiresAt: z.string().datetime().optional(),
});

function formatZodError(error: z.ZodError): { error: string; details?: unknown } {
  return {
    error: 'Validation error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

// =============================================================================
// Types
// =============================================================================

export interface RuntimeRoutesOptions {
  /** Storage backend */
  storage: Storage;
}

// =============================================================================
// Route Factory
// =============================================================================

export function createRuntimeRoutes(options: RuntimeRoutesOptions): Hono {
  const { storage } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // GET /api/spaces/:spaceId/runtimes - List runtimes
  // ---------------------------------------------------------------------------
  app.get('/:spaceId/runtimes', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      const runtimes = await storage.getRuntimesBySpace(spaceId);

      // Enrich with agent count
      const enriched = await Promise.all(
        runtimes.map(async (runtime) => {
          // Count agents bound to this runtime
          const agents = await storage.getAgentsByRuntime(runtime.id);
          const agentCount = agents.length;

          return {
            id: runtime.id,
            name: runtime.name,
            type: runtime.type,
            status: runtime.status,
            machineInfo: runtime.config?.machineInfo ?? null,
            lastSeenAt: runtime.lastSeenAt,
            createdAt: runtime.createdAt,
            agentCount,
          };
        })
      );

      return c.json({ runtimes: enriched });
    } catch (error) {
      console.error('[Runtimes] Error listing runtimes:', error);
      return c.json({ error: 'Failed to list runtimes' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/spaces/:spaceId/runtimes/:id - Get runtime details
  // ---------------------------------------------------------------------------
  app.get('/:spaceId/runtimes/:id', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');
    const runtimeId = c.req.param('id');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      const runtime = await storage.getRuntime(runtimeId);

      if (!runtime) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      // Verify runtime belongs to the space
      if (runtime.spaceId !== spaceId) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      return c.json({
        runtime: {
          id: runtime.id,
          name: runtime.name,
          type: runtime.type,
          status: runtime.status,
          machineInfo: runtime.config?.machineInfo ?? null,
          lastSeenAt: runtime.lastSeenAt,
          createdAt: runtime.createdAt,
        },
      });
    } catch (error) {
      console.error('[Runtimes] Error getting runtime:', error);
      return c.json({ error: 'Failed to get runtime' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/spaces/:spaceId/runtimes/:id/agents - List agents on runtime
  // ---------------------------------------------------------------------------
  app.get('/:spaceId/runtimes/:id/agents', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');
    const runtimeId = c.req.param('id');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      // Verify runtime exists and belongs to space
      const runtime = await storage.getRuntime(runtimeId);

      if (!runtime) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      if (runtime.spaceId !== spaceId) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      // Get agents bound to this runtime
      const agents = await storage.getAgentsByRuntime(runtimeId);

      return c.json({
        agents: agents.map((agent) => ({
          id: agent.id,
          callsign: agent.callsign,
          agentType: agent.agentType,
          status: agent.status,
          channelId: agent.channelId,
          channelName: agent.channelName,
          lastHeartbeat: agent.lastHeartbeat ?? null,
        })),
      });
    } catch (error) {
      console.error('[Runtimes] Error listing runtime agents:', error);
      return c.json({ error: 'Failed to list runtime agents' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/spaces/:spaceId/runtimes/:id - Delete runtime
  // ---------------------------------------------------------------------------
  app.delete('/:spaceId/runtimes/:id', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');
    const runtimeId = c.req.param('id');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      // Verify runtime exists and belongs to space
      const runtime = await storage.getRuntime(runtimeId);

      if (!runtime) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      if (runtime.spaceId !== spaceId) {
        return c.json({ error: 'Runtime not found' }, 404);
      }

      // Delete runtime (storage layer handles clearing runtime_id from roster entries)
      await storage.deleteRuntime(runtimeId);

      console.log(`[Runtimes] Deleted runtime ${runtimeId} (${runtime.name}) from space ${spaceId}`);

      return c.json({ ok: true });
    } catch (error) {
      console.error('[Runtimes] Error deleting runtime:', error);
      return c.json({ error: 'Failed to delete runtime' }, 500);
    }
  });

  // ===========================================================================
  // Space Secrets Endpoints
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // PUT /api/spaces/:spaceId/secrets/:key - Set a secret
  // ---------------------------------------------------------------------------
  app.put('/:spaceId/secrets/:key', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');
    const key = c.req.param('key');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    const body = await c.req.json();
    const parsed = SetSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { value, expiresAt } = parsed.data;

    try {
      await storage.setSpaceSecret(spaceId, key, {
        value,
        expiresAt,
      });

      // Get updated metadata to return
      const metadata = await storage.getSpaceSecretMetadata(spaceId, key);

      return c.json({
        key,
        setAt: metadata?.setAt,
        expiresAt: metadata?.expiresAt,
      });
    } catch (error) {
      console.error('[Spaces] Error setting secret:', error);
      return c.json({ error: 'Failed to set secret' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/spaces/:spaceId/secrets/:key - Delete a secret
  // ---------------------------------------------------------------------------
  app.delete('/:spaceId/secrets/:key', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');
    const key = c.req.param('key');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      // Check secret exists
      const metadata = await storage.getSpaceSecretMetadata(spaceId, key);
      if (!metadata) {
        return c.json({ error: `Secret not found: ${key}` }, 404);
      }

      await storage.deleteSpaceSecret(spaceId, key);

      return c.json({ deleted: true, key });
    } catch (error) {
      console.error('[Spaces] Error deleting secret:', error);
      return c.json({ error: 'Failed to delete secret' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/spaces/:spaceId/secrets - List secrets (metadata only)
  // ---------------------------------------------------------------------------
  app.get('/:spaceId/secrets', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const spaceId = c.req.param('spaceId');

    // Verify user has access to this space
    if (session.spaceId !== spaceId) {
      return c.json({ error: 'Access denied to this space' }, 403);
    }

    try {
      const secrets = await storage.listSpaceSecrets(spaceId);

      return c.json({ secrets });
    } catch (error) {
      console.error('[Spaces] Error listing secrets:', error);
      return c.json({ error: 'Failed to list secrets' }, 500);
    }
  });

  return app;
}
