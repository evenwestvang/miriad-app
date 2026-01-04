/**
 * Tymbal Protocol - NDJSON Parser
 *
 * Utilities for parsing and serializing Tymbal frames.
 */

import type {
  TymbalFrame,
  StartFrame,
  AppendFrame,
  SetFrame,
  ResetFrame,
  SyncRequest,
  SyncResponse,
  ErrorFrame,
  ArtifactFrame,
} from './frames.js';

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse a single NDJSON line into a Tymbal frame.
 * Returns null if the line is invalid.
 */
export function parseFrame(line: string): TymbalFrame | null {
  try {
    const parsed = JSON.parse(line);

    // Validate it's an object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    // Control frames (no 'i' field)
    if ('request' in parsed && parsed.request === 'sync') {
      return parsed as SyncRequest;
    }
    if ('sync' in parsed && typeof parsed.sync === 'string') {
      return parsed as SyncResponse;
    }
    if ('error' in parsed) {
      return parsed as ErrorFrame;
    }
    // Artifact frame
    if ('artifact' in parsed && typeof parsed.artifact === 'object' && parsed.artifact !== null) {
      const art = parsed.artifact;
      if (
        typeof art.action === 'string' &&
        typeof art.channelId === 'string' &&
        art.payload &&
        typeof art.payload === 'object'
      ) {
        return parsed as ArtifactFrame;
      }
      return null;
    }

    // Message frames (require 'i' field)
    if (!('i' in parsed) || typeof parsed.i !== 'string') {
      return null;
    }

    // Cannot have both 'a' and 'v'
    if ('a' in parsed && 'v' in parsed) {
      return null;
    }

    // Append frame
    if ('a' in parsed) {
      if (typeof parsed.a !== 'string') return null;
      return parsed as AppendFrame;
    }

    // Set or Reset frame
    if ('v' in parsed) {
      if (parsed.v === null) {
        return parsed as ResetFrame;
      }
      if (typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
        // SetFrame requires 't' timestamp
        if (!('t' in parsed) || typeof parsed.t !== 'string') {
          return null;
        }
        return parsed as SetFrame;
      }
      return null;
    }

    // Start frame (has 'i', optionally 'm', no 'a' or 'v')
    if ('m' in parsed) {
      if (typeof parsed.m !== 'object' || parsed.m === null) return null;
      // Reserved key check
      if ('content' in parsed.m) return null;
      return parsed as StartFrame;
    }

    // Bare start frame (just 'i')
    return parsed as StartFrame;
  } catch {
    return null;
  }
}

/**
 * Parse multiple NDJSON lines.
 * Ignores invalid lines.
 */
export function parseFrames(data: string): TymbalFrame[] {
  return data
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseFrame)
    .filter((frame): frame is TymbalFrame => frame !== null);
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a frame to NDJSON (single line, no trailing newline).
 */
export function serializeFrame(frame: TymbalFrame): string {
  return JSON.stringify(frame);
}

/**
 * Serialize a frame to NDJSON with trailing newline.
 */
export function serializeFrameLine(frame: TymbalFrame): string {
  return JSON.stringify(frame) + '\n';
}
