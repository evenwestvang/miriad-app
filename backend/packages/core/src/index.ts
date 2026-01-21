/**
 * @cast/core - Shared types and utilities for the Cast backend
 */

export const VERSION = '0.0.1';

// Types
export * from './types.js';

// Artifact schemas and validation
export * from './artifact-schemas.js';

// Tymbal streaming protocol
export * from './tymbal/index.js';

// @mention parsing and routing
export * from './mentions/index.js';

// Slug utilities
export * from './slugify.js';
