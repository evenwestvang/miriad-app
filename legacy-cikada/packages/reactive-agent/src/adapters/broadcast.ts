/**
 * Broadcast Adapter Interface
 *
 * Abstracts real-time message broadcasting for the reactive agent.
 * Implementations: WebSocket (local), API Gateway WebSocket (AWS).
 */

// =============================================================================
// Broadcast Adapter Interface
// =============================================================================

/**
 * Broadcast adapter interface for the reactive agent.
 *
 * Platform implementations:
 * - Local: Direct WebSocket connections via ws library
 * - AWS: API Gateway Management API for WebSocket
 */
export interface BroadcastAdapter {
  /**
   * Broadcast a Tymbal frame to all listeners.
   * @param frame - JSON string in Tymbal format
   */
  broadcast(frame: string): Promise<void>;

  /**
   * Check if there are any active listeners.
   * Used to skip expensive broadcast operations when no one is listening.
   */
  hasListeners(): Promise<boolean>;
}

/**
 * Factory type for creating broadcast adapters.
 * Useful for deferred construction in Lambda where we need to check listeners first.
 */
export type BroadcastAdapterFactory = (
  spaceId: string,
  channelId: string
) => BroadcastAdapter;

/**
 * Create a no-op broadcast adapter.
 * Useful when no listeners are connected.
 */
export function createNoOpBroadcastAdapter(): BroadcastAdapter {
  return {
    async broadcast(_frame: string): Promise<void> {
      // No-op
    },
    async hasListeners(): Promise<boolean> {
      return false;
    },
  };
}
