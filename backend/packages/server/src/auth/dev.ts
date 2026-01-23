/**
 * Dev Auth Routes
 *
 * Simple authentication flow for local development.
 * - List available spaces with owners
 * - Login to existing space OR create new user+space
 * - Get current session
 * - Logout
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import { ulid } from 'ulid';
import {
  createSession,
  parseSession,
  setSessionCookie,
  clearSessionCookie,
} from './session.js';
import { seedSpaceFromSanity } from '../onboarding/index.js';

// =============================================================================
// Types
// =============================================================================

export interface DevAuthOptions {
  storage: Storage;
}

interface LoginToSpaceBody {
  spaceId: string;
}

interface CreateUserAndSpaceBody {
  callsign: string;
  spaceName?: string;
}

type LoginBody = LoginToSpaceBody | CreateUserAndSpaceBody;

function isLoginToSpace(body: LoginBody): body is LoginToSpaceBody {
  return 'spaceId' in body && typeof body.spaceId === 'string';
}

function isCreateUserAndSpace(body: LoginBody): body is CreateUserAndSpaceBody {
  return 'callsign' in body && typeof body.callsign === 'string';
}

// =============================================================================
// Routes
// =============================================================================

export function createDevAuthRoutes(options: DevAuthOptions): Hono {
  const { storage } = options;
  const app = new Hono();

  /**
   * GET /auth/dev/spaces
   *
   * List all spaces with their owners for the dev login picker.
   */
  app.get('/spaces', async (c) => {
    try {
      const spacesWithOwners = await storage.listSpacesWithOwners();
      return c.json({
        spaces: spacesWithOwners,
      });
    } catch (error) {
      console.error('[DevAuth] Error listing spaces:', error);
      return c.json({ error: 'Failed to list spaces' }, 500);
    }
  });

  /**
   * POST /auth/dev/login
   *
   * Login to an existing space OR create a new user+space.
   *
   * Body variants:
   * - { spaceId: string } - Login to existing space
   * - { callsign: string, spaceName?: string } - Create new user+space
   */
  app.post('/login', async (c) => {
    let body: LoginBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      if (isLoginToSpace(body)) {
        // Login to existing space
        const space = await storage.getSpace(body.spaceId);
        if (!space) {
          return c.json({ error: 'Space not found' }, 404);
        }

        const user = await storage.getUser(space.ownerId);
        if (!user) {
          return c.json({ error: 'Space owner not found' }, 404);
        }

        // Create session
        const token = await createSession(user.id, space.id, 'dev');
        setSessionCookie(c, token);

        return c.json({
          userId: user.id,
          spaceId: space.id,
          user: {
            id: user.id,
            callsign: user.callsign,
            email: user.email,
            avatarUrl: user.avatarUrl,
          },
          space: {
            id: space.id,
            name: space.name,
            ownerId: space.ownerId,
          },
        });
      } else if (isCreateUserAndSpace(body)) {
        // Create new user + space
        if (!body.callsign || body.callsign.trim().length === 0) {
          return c.json({ error: 'Callsign is required' }, 400);
        }

        const callsign = body.callsign.trim().toLowerCase();
        const spaceName = body.spaceName?.trim() || `${callsign}'s space`;

        // Generate a dev external ID (not from a real provider)
        const externalId = `dev:${ulid()}`;

        // Create user
        const user = await storage.createUser({
          externalId,
          callsign,
        });

        // Create space owned by this user
        const space = await storage.createSpace({
          ownerId: user.id,
          name: spaceName,
        });

        // Seed space with content from Sanity
        await seedSpaceFromSanity(storage, space.id);

        // Create session
        const token = await createSession(user.id, space.id, 'dev');
        setSessionCookie(c, token);

        return c.json({
          userId: user.id,
          spaceId: space.id,
          user: {
            id: user.id,
            callsign: user.callsign,
            email: user.email,
            avatarUrl: user.avatarUrl,
          },
          space: {
            id: space.id,
            name: space.name,
            ownerId: space.ownerId,
          },
        }, 201);
      } else {
        return c.json({ error: 'Invalid request body. Provide spaceId or callsign.' }, 400);
      }
    } catch (error) {
      console.error('[DevAuth] Error during login:', error);
      return c.json({ error: 'Login failed' }, 500);
    }
  });

  /**
   * GET /auth/me
   *
   * Get current session info.
   * Returns 401 if not logged in.
   */
  app.get('/me', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    try {
      const user = await storage.getUser(session.userId);
      const space = await storage.getSpace(session.spaceId);

      if (!user || !space) {
        // Session references deleted user/space
        clearSessionCookie(c);
        return c.json({ error: 'Session invalid' }, 401);
      }

      return c.json({
        userId: session.userId,
        spaceId: session.spaceId,
        mode: session.mode,
        user: {
          id: user.id,
          callsign: user.callsign,
          email: user.email,
          avatarUrl: user.avatarUrl,
          disclaimerAcceptedVersion: user.disclaimerAcceptedVersion,
        },
        space: {
          id: space.id,
          name: space.name,
          ownerId: space.ownerId,
        },
      });
    } catch (error) {
      console.error('[DevAuth] Error getting session info:', error);
      return c.json({ error: 'Failed to get session info' }, 500);
    }
  });

  /**
   * POST /auth/logout
   *
   * Clear the session cookie.
   */
  app.post('/logout', async (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}
