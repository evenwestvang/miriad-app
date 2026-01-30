import { describe, it, expect, vi } from "vitest";
import {
  normalizeHeaders,
  prepareHttpMcpHeaders,
  type PrepareHttpMcpHeadersOptions,
} from "./mcp-auth.js";

describe("normalizeHeaders", () => {
  it("returns empty object for undefined input", () => {
    expect(normalizeHeaders(undefined)).toEqual({});
  });

  it("preserves non-authorization headers as-is", () => {
    const headers = { "Content-Type": "application/json", "X-Custom": "value" };
    expect(normalizeHeaders(headers)).toEqual(headers);
  });

  it("normalizes lowercase 'authorization' to 'Authorization'", () => {
    const headers = { authorization: "Bearer token123" };
    expect(normalizeHeaders(headers)).toEqual({
      Authorization: "Bearer token123",
    });
  });

  it("normalizes uppercase 'AUTHORIZATION' to 'Authorization'", () => {
    const headers = { AUTHORIZATION: "Bearer token123" };
    expect(normalizeHeaders(headers)).toEqual({
      Authorization: "Bearer token123",
    });
  });

  it("normalizes mixed case 'AuThOrIzAtIoN' to 'Authorization'", () => {
    const headers = { AuThOrIzAtIoN: "Bearer token123" };
    expect(normalizeHeaders(headers)).toEqual({
      Authorization: "Bearer token123",
    });
  });

  it("preserves other headers while normalizing authorization", () => {
    const headers = {
      authorization: "Bearer token123",
      "Content-Type": "application/json",
      "X-Custom": "value",
    };
    expect(normalizeHeaders(headers)).toEqual({
      Authorization: "Bearer token123",
      "Content-Type": "application/json",
      "X-Custom": "value",
    });
  });
});

describe("prepareHttpMcpHeaders", () => {
  const baseOptions: PrepareHttpMcpHeadersOptions = {
    hasOAuthConfig: false,
    channelId: "test-channel",
    mcpSlug: "test-mcp",
  };

  describe("user-configured Authorization takes precedent", () => {
    it("uses user-provided Authorization header without OAuth injection", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        configuredHeaders: { Authorization: "Bearer user-token" },
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue("oauth-token"),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBe("Bearer user-token");
      expect(result.oauthInjected).toBeUndefined();
    });

    it("normalizes lowercase authorization header and skips OAuth", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        configuredHeaders: { authorization: "Bearer user-token" },
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue("oauth-token"),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBe("Bearer user-token");
      expect(result.oauthInjected).toBeUndefined();
    });

    it("honors empty Authorization header (does not attempt OAuth)", async () => {
      const mockGetToken = vi.fn().mockResolvedValue("oauth-token");
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        configuredHeaders: { Authorization: "" },
        hasOAuthConfig: true,
        getValidOAuthToken: mockGetToken,
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBe("");
      expect(mockGetToken).not.toHaveBeenCalled();
    });
  });

  describe("OAuth token injection", () => {
    it("injects OAuth token when no Authorization header present", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        configuredHeaders: { "X-Custom": "value" },
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue("oauth-token"),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBe("Bearer oauth-token");
      expect(result.oauthInjected).toBe(true);
      expect(result.headers["X-Custom"]).toBe("value");
    });

    it("injects OAuth token with no configured headers", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue("oauth-token"),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBe("Bearer oauth-token");
      expect(result.oauthInjected).toBe(true);
    });

    it("calls getValidOAuthToken with correct parameters", async () => {
      const mockGetToken = vi.fn().mockResolvedValue("oauth-token");
      await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: true,
        getValidOAuthToken: mockGetToken,
        spaceId: "my-space",
        channelId: "my-channel",
        mcpSlug: "my-mcp",
      });

      expect(mockGetToken).toHaveBeenCalledWith("my-space", "my-channel", "my-mcp");
    });
  });

  describe("skip behavior for OAuth-configured MCPs without valid token", () => {
    it("skips when OAuth configured but token fetch returns null", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue(null),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(true);
      expect(result.skipReason).toBe("OAuth configured but no valid token");
    });

    it("skips when OAuth configured but no token fetcher provided", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: true,
        spaceId: "test-space",
        // getValidOAuthToken not provided
      });

      expect(result.skip).toBe(true);
      expect(result.skipReason).toBe("OAuth configured but token fetcher not available");
    });

    it("skips when OAuth configured but no spaceId provided", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: true,
        getValidOAuthToken: vi.fn().mockResolvedValue("token"),
        // spaceId not provided
      });

      expect(result.skip).toBe(true);
      expect(result.skipReason).toBe("OAuth configured but token fetcher not available");
    });
  });

  describe("no OAuth config - proceeds without auth", () => {
    it("proceeds without auth when no OAuth config and no Authorization header", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        configuredHeaders: { "X-Custom": "value" },
        hasOAuthConfig: false,
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBeUndefined();
      expect(result.headers["X-Custom"]).toBe("value");
    });

    it("does not skip when OAuth not configured and token fetch fails", async () => {
      const result = await prepareHttpMcpHeaders({
        ...baseOptions,
        hasOAuthConfig: false,
        getValidOAuthToken: vi.fn().mockResolvedValue(null),
        spaceId: "test-space",
      });

      expect(result.skip).toBe(false);
      expect(result.headers.Authorization).toBeUndefined();
    });
  });
});
