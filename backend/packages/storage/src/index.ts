/**
 * @cast/storage - Storage interface and implementations
 *
 * For now, just a placeholder. Real implementation comes in Phase 1.
 */

export interface Storage {
  // Placeholder - will be filled in Phase 1
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export class StubStorage implements Storage {
  async initialize(): Promise<void> {
    // No-op for now
  }

  async close(): Promise<void> {
    // No-op for now
  }
}
