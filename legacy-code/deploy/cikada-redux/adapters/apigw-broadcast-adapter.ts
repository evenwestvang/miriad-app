/**
 * API Gateway WebSocket Broadcast Adapter
 *
 * Wraps the channel-broadcast functions to match the BroadcastAdapter
 * interface from @cikada/reactive-agent.
 */

import type { BroadcastAdapter } from "@cikada/reactive-agent";
import {
  createChannelBroadcaster,
  hasChannelListeners,
} from "../channel-broadcast.js";

// =============================================================================
// API Gateway Broadcast Adapter
// =============================================================================

/**
 * Broadcast adapter for AWS Lambda using API Gateway WebSocket.
 * Wraps the existing channel-broadcast infrastructure.
 */
export class ApiGwBroadcastAdapter implements BroadcastAdapter {
  private spaceId: string;
  private channelId: string;
  private broadcastFn: (frame: string) => Promise<void>;
  private hasListenersResult: boolean | null = null;

  constructor(spaceId: string, channelId: string) {
    this.spaceId = spaceId;
    this.channelId = channelId;
    this.broadcastFn = createChannelBroadcaster(spaceId, channelId);
  }

  /**
   * Broadcast a Tymbal frame to all WebSocket connections.
   */
  async broadcast(frame: string): Promise<void> {
    await this.broadcastFn(frame);
  }

  /**
   * Check if there are any active WebSocket listeners.
   * Result is cached for the lifetime of the adapter.
   */
  async hasListeners(): Promise<boolean> {
    if (this.hasListenersResult === null) {
      this.hasListenersResult = await hasChannelListeners(
        this.spaceId,
        this.channelId
      );
    }
    return this.hasListenersResult;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an API Gateway broadcast adapter for a channel.
 */
export function createApiGwBroadcastAdapter(
  spaceId: string,
  channelId: string
): ApiGwBroadcastAdapter {
  return new ApiGwBroadcastAdapter(spaceId, channelId);
}
