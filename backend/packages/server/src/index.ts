/**
 * @cast/server - HTTP API and WebSocket server
 *
 * Exports the app factory for use by different adapters (local dev, Lambda, etc.)
 */

// App factory (main export)
export { createApp, type AppOptions } from './app.js';

// Auth middleware and utilities
export * from './auth/index.js';

// WebSocket connection management
export * from './websocket/index.js';

// Request handlers
export * from './handlers/index.js';

// Agent management
export * from './agents/index.js';

// Asset storage
export * from './assets/index.js';

// Space seeding
export { seedSpace } from './seed.js';
