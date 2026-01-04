/**
 * Local Broadcast Adapter
 *
 * Wraps a broadcast function to implement the BroadcastAdapter interface
 * from @cikada/reactive-agent.
 */

import type { BroadcastAdapter } from "@cikada/reactive-agent";

// =============================================================================
// Local Broadcast Adapter
// =============================================================================

/**
 * Broadcast adapter for local development.
 * Wraps a simple broadcast function (typically connected to WebSocket).
 */
export class LocalBroadcastAdapter implements BroadcastAdapter {
  private broadcastFn: (frame: string) => Promise<void>;
  private listenerCount: number;

  constructor(
    broadcastFn: (frame: string) => Promise<void>,
    hasListeners: boolean = true
  ) {
    this.broadcastFn = broadcastFn;
    this.listenerCount = hasListeners ? 1 : 0;
  }

  /**
   * Broadcast a Tymbal frame to all listeners.
   */
  async broadcast(frame: string): Promise<void> {
    await this.broadcastFn(frame);
  }

  /**
   * Check if there are any active listeners.
   */
  async hasListeners(): Promise<boolean> {
    return this.listenerCount > 0;
  }
}

/**
 * Create a local broadcast adapter from a broadcast function.
 */
export function createLocalBroadcastAdapter(
  broadcastFn: (frame: string) => Promise<void>,
  hasListeners: boolean = true
): LocalBroadcastAdapter {
  return new LocalBroadcastAdapter(broadcastFn, hasListeners);
}
