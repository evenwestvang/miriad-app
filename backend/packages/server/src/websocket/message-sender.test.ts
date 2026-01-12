import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketSender } from './message-sender.js';

// Mock WebSocket
function createMockWebSocket(readyState = WebSocket.OPEN): WebSocket {
  const ws = {
    readyState,
    send: vi.fn((data: string, callback?: (err?: Error) => void) => {
      if (callback) callback();
    }),
  };
  return ws as unknown as WebSocket;
}

describe('WebSocketSender', () => {
  let sender: WebSocketSender;

  beforeEach(() => {
    sender = new WebSocketSender();
  });

  describe('register/unregister', () => {
    it('registers a WebSocket connection', () => {
      const ws = createMockWebSocket();
      sender.register('conn-1', ws);

      expect(sender.hasConnection('conn-1')).toBe(true);
      expect(sender.getConnectionCount()).toBe(1);
    });

    it('unregisters a WebSocket connection', () => {
      const ws = createMockWebSocket();
      sender.register('conn-1', ws);
      sender.unregister('conn-1');

      expect(sender.hasConnection('conn-1')).toBe(false);
      expect(sender.getConnectionCount()).toBe(0);
    });
  });

  describe('send', () => {
    it('sends data to a registered connection', async () => {
      const ws = createMockWebSocket();
      sender.register('conn-1', ws);

      const success = await sender.send('conn-1', 'test data');

      expect(success).toBe(true);
      expect(ws.send).toHaveBeenCalledWith('test data', expect.any(Function));
    });

    it('returns false for unregistered connection', async () => {
      const success = await sender.send('unknown', 'test data');
      expect(success).toBe(false);
    });

    it('returns false for closed connection', async () => {
      const ws = createMockWebSocket(WebSocket.CLOSED);
      sender.register('conn-1', ws);

      const success = await sender.send('conn-1', 'test data');

      expect(success).toBe(false);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('returns false on send error', async () => {
      const ws = createMockWebSocket();
      ws.send = vi.fn((data: string, callback?: (err?: Error) => void) => {
        if (callback) callback(new Error('send failed'));
      }) as any;
      sender.register('conn-1', ws);

      const success = await sender.send('conn-1', 'test data');

      expect(success).toBe(false);
    });
  });

  describe('getConnectionCount', () => {
    it('returns the correct count', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      expect(sender.getConnectionCount()).toBe(0);

      sender.register('conn-1', ws1);
      expect(sender.getConnectionCount()).toBe(1);

      sender.register('conn-2', ws2);
      expect(sender.getConnectionCount()).toBe(2);

      sender.unregister('conn-1');
      expect(sender.getConnectionCount()).toBe(1);
    });
  });

  describe('hasConnection', () => {
    it('returns true for registered connection', () => {
      const ws = createMockWebSocket();
      sender.register('conn-1', ws);

      expect(sender.hasConnection('conn-1')).toBe(true);
    });

    it('returns false for unregistered connection', () => {
      expect(sender.hasConnection('unknown')).toBe(false);
    });
  });
});

// ApiGatewaySender tests would require mocking AWS SDK
// and are better suited for integration tests
