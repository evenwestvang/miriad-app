/**
 * ULID Generation
 *
 * ULIDs are used as message IDs because they are:
 * - Lexicographically sortable (sort by ULID = sort by time)
 * - URL-safe
 * - More readable than UUIDs
 */

import { ulid } from "ulid";

/**
 * Generate a new ULID
 */
export function generateUlid(): string {
  return ulid();
}

/**
 * Generate a message ID (alias for generateUlid)
 */
export function generateMessageId(): string {
  return ulid();
}
