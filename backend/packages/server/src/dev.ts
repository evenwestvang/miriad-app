/**
 * Local development server
 *
 * Run with: pnpm dev
 */

import { serve } from '@hono/node-server';
import { app } from './index.js';

const port = parseInt(process.env.PORT ?? '3001', 10);

console.log(`Starting Cast backend on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Server running at http://localhost:${port}`);
console.log(`Health check: http://localhost:${port}/health`);
