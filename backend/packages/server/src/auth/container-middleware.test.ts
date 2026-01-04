import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { generateContainerToken } from './container-token.js';
import {
  requireContainerAuth,
  optionalContainerAuth,
  type ContainerAuthVariables,
} from './container-middleware.js';

describe('Container Middleware', () => {
  const testPayload = {
    spaceId: 'space123',
    channelId: 'channel456',
    callsign: 'agent789',
  };

  describe('requireContainerAuth', () => {
    const app = new Hono<{ Variables: ContainerAuthVariables }>();
    app.use('/protected/*', requireContainerAuth());
    app.get('/protected/resource', (c) => {
      const container = c.get('container');
      return c.json({ container });
    });

    it('allows request with valid token', async () => {
      const token = generateContainerToken(testPayload);
      const res = await app.request('/protected/resource', {
        headers: { Authorization: `Container ${token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.container).toEqual(testPayload);
    });

    it('rejects request without Authorization header', async () => {
      const res = await app.request('/protected/resource');

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Missing Authorization header');
    });

    it('rejects request with wrong auth scheme', async () => {
      const res = await app.request('/protected/resource', {
        headers: { Authorization: 'Bearer sometoken' },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain('Invalid Authorization format');
    });

    it('rejects request with invalid token', async () => {
      const res = await app.request('/protected/resource', {
        headers: { Authorization: 'Container invalid.token' },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Invalid container token');
    });

    it('handles case-insensitive "Container" scheme', async () => {
      const token = generateContainerToken(testPayload);
      const res = await app.request('/protected/resource', {
        headers: { Authorization: `CONTAINER ${token}` },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('optionalContainerAuth', () => {
    const app = new Hono<{ Variables: ContainerAuthVariables }>();
    app.use('/optional/*', optionalContainerAuth());
    app.get('/optional/resource', (c) => {
      const container = c.get('container');
      return c.json({ hasAuth: !!container, container: container ?? null });
    });

    it('passes through request without auth', async () => {
      const res = await app.request('/optional/resource');

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hasAuth).toBe(false);
      expect(data.container).toBeNull();
    });

    it('parses valid token when present', async () => {
      const token = generateContainerToken(testPayload);
      const res = await app.request('/optional/resource', {
        headers: { Authorization: `Container ${token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hasAuth).toBe(true);
      expect(data.container).toEqual(testPayload);
    });

    it('ignores invalid token silently', async () => {
      const res = await app.request('/optional/resource', {
        headers: { Authorization: 'Container invalid.token' },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hasAuth).toBe(false);
    });

    it('ignores wrong auth scheme silently', async () => {
      const res = await app.request('/optional/resource', {
        headers: { Authorization: 'Bearer sometoken' },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hasAuth).toBe(false);
    });
  });
});
