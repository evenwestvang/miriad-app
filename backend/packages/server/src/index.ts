/**
 * @cast/server - HTTP API and WebSocket server
 *
 * Exports the Hono app for use by different adapters (local dev, Lambda, etc.)
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';

export const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.0.1',
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Cast Backend',
    version: '0.0.1',
    docs: '/health',
  });
});

export default app;
