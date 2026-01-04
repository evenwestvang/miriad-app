import { describe, it, expect } from 'vitest';
import { app } from './index.js';

describe('Cast Server', () => {
  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.version).toBe('0.0.1');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('GET /', () => {
    it('returns service info', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.name).toBe('Cast Backend');
      expect(data.version).toBe('0.0.1');
    });
  });
});
