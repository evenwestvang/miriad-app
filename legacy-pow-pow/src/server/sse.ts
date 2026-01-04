/**
 * Server-Sent Events (SSE) infrastructure for real-time updates.
 *
 * Central invalidation stream that notifies clients when:
 * - Channel list changes (created, archived, unarchived)
 * - Agent state changes (spawned, kicked, status updates)
 *
 * Clients should use this for invalidation-based updates rather than polling.
 */

import type { ServerResponse } from "http";

/**
 * SSE event types for the central invalidation stream.
 */
export type SSEEventType =
  | "channels_changed"      // Channel list was modified
  | "agents_changed"        // Agent list/state was modified
  | "ping";                 // Keepalive

/**
 * SSE event payload.
 */
export interface SSEEvent {
  type: SSEEventType;
  /** Optional channel name for scoped events */
  channel?: string;
  /** Optional agent name for agent-specific events */
  agent?: string;
  /** Timestamp of the event */
  timestamp: string;
}

/**
 * Connected SSE client.
 */
interface SSEClient {
  id: string;
  res: ServerResponse;
  connectedAt: number;
}

/**
 * Central SSE connection manager.
 * Manages connections and broadcasts events to all connected clients.
 */
class SSEManager {
  private clients = new Map<string, SSEClient>();
  private clientCounter = 0;
  private keepaliveInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start keepalive pings every 30 seconds
    this.keepaliveInterval = setInterval(() => {
      this.broadcast({ type: "ping", timestamp: new Date().toISOString() });
    }, 30000);
  }

  /**
   * Add a new SSE client connection.
   */
  addClient(res: ServerResponse): string {
    const id = `sse_central_${++this.clientCounter}`;
    this.clients.set(id, {
      id,
      res,
      connectedAt: Date.now(),
    });
    console.error(`[sse] Central stream connected: ${id} (total: ${this.clients.size})`);
    return id;
  }

  /**
   * Remove an SSE client connection.
   */
  removeClient(id: string): void {
    if (this.clients.delete(id)) {
      console.error(`[sse] Central stream disconnected: ${id} (total: ${this.clients.size})`);
    }
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(event: SSEEvent): void {
    const data = JSON.stringify(event);
    const deadClients: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.res.write(`event: ${event.type}\n`);
        client.res.write(`data: ${data}\n\n`);
      } catch (err) {
        console.error(`[sse] Write error for ${id}:`, err);
        deadClients.push(id);
      }
    }

    // Clean up dead connections
    for (const id of deadClients) {
      this.removeClient(id);
    }
  }

  /**
   * Get connection stats.
   */
  getStats(): { connections: number } {
    return { connections: this.clients.size };
  }

  /**
   * Cleanup (for testing).
   */
  shutdown(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.clients.clear();
  }
}

// Singleton instance
export const sseManager = new SSEManager();

/**
 * Emit a channels_changed event.
 * Call this when channels are created, archived, or unarchived.
 */
export function emitChannelsChanged(channel?: string): void {
  sseManager.broadcast({
    type: "channels_changed",
    channel,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit an agents_changed event.
 * Call this when agents are spawned, kicked, or have state changes.
 */
export function emitAgentsChanged(channel?: string, agent?: string): void {
  sseManager.broadcast({
    type: "agents_changed",
    channel,
    agent,
    timestamp: new Date().toISOString(),
  });
}
