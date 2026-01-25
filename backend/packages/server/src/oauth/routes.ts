/**
 * OAuth Routes for HTTP MCP Servers
 *
 * Handles OAuth 2.1 authorization flow for system.mcp artifacts.
 *
 * Endpoints:
 * - GET  /api/oauth/status    - Check OAuth connection status
 * - POST /api/oauth/start     - Start OAuth authorization flow
 * - POST /api/oauth/disconnect - Clear OAuth tokens
 * - GET  /api/oauth/callback  - OAuth callback (redirected from provider)
 */

import { Hono } from "hono";
import type { Storage } from "@cast/storage";
import { requireAuth, getSpaceId } from "../auth/index.js";
import {
  getOAuthStatus,
  saveOAuthTokens,
  deleteOAuthTokens,
} from "./storage.js";
import {
  startOAuthFlow,
  validateCallback,
  OAuthCallbackError,
  type PendingAuthState,
} from "./flow.js";
import { exchangeCodeForTokens } from "./tokens.js";

/**
 * In-memory store for pending authorization states.
 * Key is the state parameter.
 */
const pendingAuthStates = new Map<string, PendingAuthState>();

// =============================================================================
// Types
// =============================================================================

export interface OAuthRoutesOptions {
  /** Storage backend */
  storage: Storage;
  /** Base URL for API (used for OAuth callback redirect URI) */
  apiUrl: string;
}

// =============================================================================
// Route Factory
// =============================================================================

export function createOAuthRoutes(options: OAuthRoutesOptions): Hono {
  const { storage, apiUrl } = options;
  const app = new Hono();

  // All OAuth routes require user authentication except callback
  // Callback needs to work for the popup redirect
  app.use("/status", requireAuth);
  app.use("/start", requireAuth);
  app.use("/disconnect", requireAuth);

  // ---------------------------------------------------------------------------
  // GET /status - Check OAuth connection status
  // ---------------------------------------------------------------------------
  app.get("/status", async (c) => {
    const spaceId = getSpaceId(c);
    const channel = c.req.query("channel");
    const mcpSlug = c.req.query("mcpSlug");

    if (!channel || !mcpSlug) {
      return c.json(
        { error: "channel and mcpSlug query parameters are required" },
        400
      );
    }

    try {
      // Resolve channel (could be name or ID)
      const resolvedChannel = await storage.resolveChannel(spaceId, channel);
      if (!resolvedChannel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Verify the MCP artifact exists
      const artifact = await storage.getArtifact(resolvedChannel.id, mcpSlug);
      if (!artifact || artifact.type !== "system.mcp") {
        return c.json({ error: "MCP artifact not found" }, 404);
      }

      const status = await getOAuthStatus(
        storage,
        spaceId,
        resolvedChannel.id,
        mcpSlug
      );

      return c.json(status);
    } catch (error) {
      console.error("[OAuth] Error getting status:", error);
      return c.json({ error: "Failed to get OAuth status" }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /start - Start OAuth authorization flow
  // ---------------------------------------------------------------------------
  app.post("/start", async (c) => {
    const spaceId = getSpaceId(c);

    let body: { channel?: string; mcpSlug?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { channel, mcpSlug } = body;
    if (!channel || !mcpSlug) {
      return c.json({ error: "channel and mcpSlug are required" }, 400);
    }

    try {
      // Resolve channel
      const resolvedChannel = await storage.resolveChannel(spaceId, channel);
      if (!resolvedChannel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Get the MCP artifact to find its URL
      const artifact = await storage.getArtifact(resolvedChannel.id, mcpSlug);
      if (!artifact || artifact.type !== "system.mcp") {
        return c.json({ error: "MCP artifact not found" }, 404);
      }

      const props = artifact.props as { url?: string; transport?: string } | undefined;
      if (props?.transport !== "http" || !props?.url) {
        return c.json(
          { error: "MCP artifact is not an HTTP transport with a URL" },
          400
        );
      }

      const mcpUrl = props.url;
      const redirectUri = `${apiUrl}/api/oauth/callback`;

      // Extract OAuth config from props if present
      const authConfig = (props as { oauth?: { type: 'oauth'; clientId?: string; scopes?: string[] } }).oauth;

      // Start OAuth flow (handles client registration internally)
      const result = await startOAuthFlow({
        mcpSlug,
        channelId: resolvedChannel.id,
        spaceId,
        mcpUrl,
        authConfig,
        redirectUri,
        pendingStates: pendingAuthStates,
      });

      return c.json({
        authorizationUrl: result.authorizationUrl,
        state: result.state,
      });
    } catch (error) {
      console.error("[OAuth] Error starting flow:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: `Failed to start OAuth flow: ${message}` }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /disconnect - Clear OAuth tokens
  // ---------------------------------------------------------------------------
  app.post("/disconnect", async (c) => {
    const spaceId = getSpaceId(c);

    let body: { channel?: string; mcpSlug?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { channel, mcpSlug } = body;
    if (!channel || !mcpSlug) {
      return c.json({ error: "channel and mcpSlug are required" }, 400);
    }

    try {
      // Resolve channel
      const resolvedChannel = await storage.resolveChannel(spaceId, channel);
      if (!resolvedChannel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Verify the MCP artifact exists
      const artifact = await storage.getArtifact(resolvedChannel.id, mcpSlug);
      if (!artifact || artifact.type !== "system.mcp") {
        return c.json({ error: "MCP artifact not found" }, 404);
      }

      await deleteOAuthTokens(storage, resolvedChannel.id, mcpSlug);

      return c.json({ success: true });
    } catch (error) {
      console.error("[OAuth] Error disconnecting:", error);
      return c.json({ error: "Failed to disconnect OAuth" }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /callback - OAuth callback from authorization server
  // ---------------------------------------------------------------------------
  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    // Handle error response from authorization server
    if (error) {
      return c.html(
        buildCallbackPage({
          success: false,
          error,
          errorDescription: errorDescription ?? undefined,
        })
      );
    }

    try {
      // Validate the callback using flow module
      const { code: authCode, pendingState } = validateCallback(
        {
          code,
          state,
          error,
          error_description: errorDescription,
        },
        pendingAuthStates
      );

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(
        pendingState.tokenEndpoint,
        authCode,
        pendingState.codeVerifier,
        pendingState.redirectUri,
        pendingState.clientId,
        pendingState.clientSecret
      );

      // Save tokens to artifact secrets
      await saveOAuthTokens(
        storage,
        pendingState.spaceId,
        pendingState.channelId,
        pendingState.mcpSlug,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          clientId: pendingState.clientId,
        }
      );

      return c.html(buildCallbackPage({ success: true }));
    } catch (err) {
      console.error("[OAuth] Callback failed:", err);

      if (err instanceof OAuthCallbackError) {
        return c.html(
          buildCallbackPage({
            success: false,
            error: err.code,
            errorDescription: err.message,
          })
        );
      }

      const message = err instanceof Error ? err.message : "Unknown error";
      return c.html(
        buildCallbackPage({
          success: false,
          error: "token_exchange_failed",
          errorDescription: message,
        })
      );
    }
  });

  return app;
}

// =============================================================================
// Callback Page Builder
// =============================================================================

interface CallbackPageParams {
  success: boolean;
  error?: string;
  errorDescription?: string;
}

/**
 * Build the OAuth callback HTML page.
 * This page posts a message to the opener window and closes itself.
 */
function buildCallbackPage(params: CallbackPageParams): string {
  const { success, error, errorDescription } = params;

  const message = JSON.stringify({
    type: "oauth-callback",
    success,
    error,
    errorDescription,
  });

  return `<!DOCTYPE html>
<html>
<head>
  <title>OAuth ${success ? "Complete" : "Failed"}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      max-width: 400px;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 1rem;
    }
    .success { color: #22c55e; }
    .error { color: #ef4444; }
    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
    }
    p {
      margin: 0;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon ${success ? "success" : "error"}">
      ${success ? "✓" : "✗"}
    </div>
    <h1>${success ? "Connected!" : "Connection Failed"}</h1>
    <p>${success ? "You can close this window." : (errorDescription || error || "An error occurred")}</p>
  </div>
  <script>
    // Post message to opener window
    if (window.opener) {
      window.opener.postMessage(${message}, "*");
    }
    // Close after a short delay so user can see the status
    setTimeout(() => window.close(), 1500);
  </script>
</body>
</html>`;
}
