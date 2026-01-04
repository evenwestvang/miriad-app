/**
 * Cikada Platform - Space Types
 *
 * A space is an isolated tenant environment containing channels, #root, and config.
 * Each user gets their own space with unique channel names scoped to that space.
 */

// =============================================================================
// Space Types
// =============================================================================

/**
 * A space represents an isolated tenant environment.
 * Spaces contain channels, roster entries, and artifacts.
 * Channel names are unique within a space but can duplicate across spaces.
 */
export interface Space {
  /** Unique space identifier (ULID) */
  id: string;

  /** Owner's external identity (e.g., Sanity user ID) */
  ownerId: string;

  /** Optional display name for the space */
  name?: string;

  /** ISO timestamp when the space was created */
  createdAt: string;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isSpace(value: unknown): value is Space {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Space).id === 'string' &&
    typeof (value as Space).ownerId === 'string' &&
    typeof (value as Space).createdAt === 'string'
  );
}
