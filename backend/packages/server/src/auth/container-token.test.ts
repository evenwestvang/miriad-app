import { describe, it, expect } from 'vitest';
import { generateContainerToken, verifyContainerToken } from './container-token.js';

describe('Container Token', () => {
  const testPayload = {
    spaceId: 'space123',
    channelId: 'channel456',
    callsign: 'agent789',
  };

  describe('generateContainerToken', () => {
    it('generates a token in the correct format', () => {
      const token = generateContainerToken(testPayload);

      // Should be base64url.hmac format
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

      // Should have two parts separated by dot
      const parts = token.split('.');
      expect(parts).toHaveLength(2);
    });

    it('generates different tokens for different payloads', () => {
      const token1 = generateContainerToken(testPayload);
      const token2 = generateContainerToken({
        ...testPayload,
        callsign: 'different',
      });

      expect(token1).not.toBe(token2);
    });

    it('generates consistent tokens for same payload', () => {
      const token1 = generateContainerToken(testPayload);
      const token2 = generateContainerToken(testPayload);

      expect(token1).toBe(token2);
    });
  });

  describe('verifyContainerToken', () => {
    it('verifies a valid token and returns payload', () => {
      const token = generateContainerToken(testPayload);
      const result = verifyContainerToken(token);

      expect(result).toEqual(testPayload);
    });

    it('returns null for invalid format (no dot)', () => {
      const result = verifyContainerToken('invalidtoken');
      expect(result).toBeNull();
    });

    it('returns null for invalid format (multiple dots)', () => {
      const result = verifyContainerToken('a.b.c');
      expect(result).toBeNull();
    });

    it('returns null for tampered payload', () => {
      const token = generateContainerToken(testPayload);
      const [, hmac] = token.split('.');

      // Create different payload
      const tamperedData = Buffer.from('evil:data:here').toString('base64url');
      const tamperedToken = `${tamperedData}.${hmac}`;

      const result = verifyContainerToken(tamperedToken);
      expect(result).toBeNull();
    });

    it('returns null for tampered HMAC', () => {
      const token = generateContainerToken(testPayload);
      const [encodedData] = token.split('.');

      const tamperedToken = `${encodedData}.tampered_hmac`;

      const result = verifyContainerToken(tamperedToken);
      expect(result).toBeNull();
    });

    it('returns null for invalid base64', () => {
      const result = verifyContainerToken('!!!invalid!!!.hmac');
      expect(result).toBeNull();
    });

    it('returns null for malformed payload (wrong number of parts)', () => {
      // Manually create a token with wrong payload format
      const badData = Buffer.from('only:two').toString('base64url');
      // We can't create a valid HMAC without the secret, so this will fail HMAC check
      const result = verifyContainerToken(`${badData}.fake`);
      expect(result).toBeNull();
    });
  });

  describe('round trip', () => {
    it('handles special characters in callsign', () => {
      const payload = {
        spaceId: 'space-123',
        channelId: 'channel_456',
        callsign: 'agent.name',
      };

      const token = generateContainerToken(payload);
      const result = verifyContainerToken(token);

      expect(result).toEqual(payload);
    });

    it('handles ULIDs as IDs', () => {
      const payload = {
        spaceId: '01HQJK5X7E8M3G4B2C6D9F0A1N',
        channelId: '01HQJK5X7E8M3G4B2C6D9F0A2P',
        callsign: 'delta',
      };

      const token = generateContainerToken(payload);
      const result = verifyContainerToken(token);

      expect(result).toEqual(payload);
    });
  });
});
