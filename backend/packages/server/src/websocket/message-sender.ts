/**
 * Message Sender Interface
 *
 * Abstracts the platform-specific mechanism for sending messages to WebSocket connections.
 * - Local dev: uses actual WebSocket instances
 * - Lambda: uses API Gateway Management API
 */

import { WebSocket } from 'ws';

// =============================================================================
// Interface
// =============================================================================

/**
 * Interface for sending messages to WebSocket connections.
 * Platform-specific implementations handle the actual transport.
 */
export interface MessageSender {
  /**
   * Send data to a connection.
   * @returns true if sent successfully, false if connection is gone (stale)
   */
  send(connectionId: string, data: string): Promise<boolean>;

  /**
   * Register a WebSocket instance for a connectionId.
   * Only used by WebSocketSender - no-op for ApiGatewaySender.
   */
  register?(connectionId: string, ws: WebSocket): void;

  /**
   * Unregister a WebSocket instance.
   * Only used by WebSocketSender - no-op for ApiGatewaySender.
   */
  unregister?(connectionId: string): void;
}

// =============================================================================
// WebSocket Sender (Local Dev)
// =============================================================================

/**
 * MessageSender implementation for local development.
 * Holds WebSocket instances in memory and sends directly.
 */
export class WebSocketSender implements MessageSender {
  private sockets = new Map<string, WebSocket>();

  /**
   * Register a WebSocket instance for a connectionId.
   * Called when a new WebSocket connection is established.
   */
  register(connectionId: string, ws: WebSocket): void {
    this.sockets.set(connectionId, ws);
  }

  /**
   * Unregister a WebSocket instance.
   * Called when a WebSocket connection is closed.
   */
  unregister(connectionId: string): void {
    this.sockets.delete(connectionId);
  }

  /**
   * Send data to a connection via WebSocket.
   * @returns true if sent, false if connection is gone/closed
   */
  async send(connectionId: string, data: string): Promise<boolean> {
    const ws = this.sockets.get(connectionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false; // Stale - server restarted or client disconnected
    }

    return new Promise((resolve) => {
      ws.send(data, (err) => {
        if (err) {
          console.error(`[WebSocketSender] Error sending to ${connectionId}:`, err);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Get the number of registered connections.
   * Useful for debugging/monitoring.
   */
  getConnectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Check if a connection is registered.
   */
  hasConnection(connectionId: string): boolean {
    return this.sockets.has(connectionId);
  }
}

// =============================================================================
// API Gateway Sender (Lambda)
// =============================================================================

/**
 * Options for ApiGatewaySender
 */
export interface ApiGatewaySenderOptions {
  /** API Gateway WebSocket endpoint URL (https://...) */
  endpoint: string;
  /** AWS region (defaults to AWS_REGION env var or us-east-1) */
  region?: string;
}

/**
 * MessageSender implementation for AWS Lambda.
 * Uses API Gateway Management API to send messages.
 */
export class ApiGatewaySender implements MessageSender {
  private endpoint: string;
  private region: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  constructor(options: ApiGatewaySenderOptions) {
    this.endpoint = options.endpoint;
    this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  }

  /**
   * Get or create the API Gateway client.
   * Lazily initialized to avoid import issues in non-Lambda environments.
   */
  private async getClient(): Promise<any> {
    if (!this.client) {
      // Dynamic import to avoid loading AWS SDK in local dev
      const { ApiGatewayManagementApiClient } = await import(
        '@aws-sdk/client-apigatewaymanagementapi'
      );
      this.client = new ApiGatewayManagementApiClient({
        region: this.region,
        endpoint: this.endpoint,
      });
    }
    return this.client;
  }

  /**
   * No-op for Lambda - we don't hold WebSocket instances.
   */
  register(_connectionId: string, _ws: WebSocket): void {
    // No-op - Lambda doesn't hold WebSocket instances
  }

  /**
   * No-op for Lambda - we don't hold WebSocket instances.
   */
  unregister(_connectionId: string): void {
    // No-op - Lambda doesn't hold WebSocket instances
  }

  /**
   * Send data to a connection via API Gateway Management API.
   * @returns true if sent, false if connection is gone (GoneException)
   */
  async send(connectionId: string, data: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      const { PostToConnectionCommand } = await import(
        '@aws-sdk/client-apigatewaymanagementapi'
      );

      await client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(data),
        })
      );
      return true;
    } catch (error) {
      // Check for GoneException (connection is stale)
      if (error && typeof error === 'object' && 'name' in error) {
        if (error.name === 'GoneException') {
          console.log(`[ApiGatewaySender] Connection ${connectionId} is gone`);
          return false;
        }
      }
      console.error(`[ApiGatewaySender] Error sending to ${connectionId}:`, error);
      throw error;
    }
  }
}
