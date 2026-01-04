/**
 * OAuth API routes
 *
 * Provides HTTP endpoints for OAuth flows:
 * - GET /api/oauth/status - Get OAuth connection status for an MCP
 * - POST /api/oauth/start - Start OAuth flow for an MCP
 * - POST /api/oauth/disconnect - Disconnect OAuth for an MCP
 * - GET /api/oauth/callback - OAuth callback handler
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  startOAuthFlow,
  validateCallback,
  OAuthCallbackError,
} from "./flow.js";
import type { OAuthConfig } from "../artifact-schemas.js";

/**
 * OAuth connection status response.
 */
export interface OAuthStatusResponse {
  status: "connected" | "disconnected" | "expired";
  /** When the token expires (ISO 8601) */
  expiresAt?: string;
  /** Scopes granted */
  scopes?: string[];
}

/**
 * OAuth start request body.
 */
export interface OAuthStartRequest {
  /** The system.mcp artifact slug */
  mcpSlug: string;
  /** The channel containing the artifact */
  channel: string;
}

/**
 * OAuth start response.
 */
export interface OAuthStartResponse {
  /** The authorization URL to open in a popup */
  authorizationUrl: string;
  /** State parameter for verification */
  state: string;
}

/**
 * OAuth disconnect request body.
 */
export interface OAuthDisconnectRequest {
  /** The system.mcp artifact slug */
  mcpSlug: string;
  /** The channel containing the artifact */
  channel: string;
}

/**
 * Dependencies injected into OAuth API handlers.
 */
export interface OAuthApiDependencies {
  /** Get a system.mcp artifact by channel and slug */
  getMcpArtifact: (
    channel: string,
    slug: string
  ) => Promise<{ props?: { url?: string; auth?: OAuthConfig } } | null> | { props?: { url?: string; auth?: OAuthConfig } } | null;

  /** Get stored OAuth tokens for an MCP */
  getStoredTokens: (
    channel: string,
    mcpSlug: string
  ) => { accessToken: string; expiresAt?: string; scopes?: string[] } | null;

  /** Store OAuth tokens for an MCP */
  storeTokens: (
    channel: string,
    mcpSlug: string,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      scopes?: string[];
    },
    mcpUrl: string
  ) => void;

  /** Clear stored OAuth tokens for an MCP */
  clearTokens: (channel: string, mcpSlug: string) => void;

  /** Exchange authorization code for tokens */
  exchangeCodeForTokens: (
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    redirectUri: string,
    clientId: string
  ) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
  }>;

  /** Base URL for building redirect URIs */
  baseUrl: string;
}

/**
 * Parse JSON body from request.
 */
async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Handle GET /api/oauth/status
 *
 * Query params:
 * - mcpSlug: The system.mcp artifact slug
 * - channel: The channel containing the artifact
 */
export async function handleOAuthStatus(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: OAuthApiDependencies
): Promise<void> {
  const mcpSlug = url.searchParams.get("mcpSlug");
  const channel = url.searchParams.get("channel");

  if (!mcpSlug || !channel) {
    sendJson(res, 400, { error: "Missing mcpSlug or channel parameter" });
    return;
  }

  // Check for stored tokens
  const tokens = deps.getStoredTokens(channel, mcpSlug);

  if (!tokens) {
    sendJson(res, 200, { status: "disconnected" } as OAuthStatusResponse);
    return;
  }

  // Check if token is expired
  if (tokens.expiresAt) {
    const expiresAt = new Date(tokens.expiresAt);
    if (expiresAt <= new Date()) {
      sendJson(res, 200, {
        status: "expired",
        expiresAt: tokens.expiresAt,
      } as OAuthStatusResponse);
      return;
    }
  }

  sendJson(res, 200, {
    status: "connected",
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  } as OAuthStatusResponse);
}

/**
 * Handle POST /api/oauth/start
 *
 * Body:
 * - mcpSlug: The system.mcp artifact slug
 * - channel: The channel containing the artifact
 */
export async function handleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthApiDependencies
): Promise<void> {
  let body: OAuthStartRequest;
  try {
    body = await parseJsonBody<OAuthStartRequest>(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { mcpSlug, channel } = body;

  if (!mcpSlug || !channel) {
    sendJson(res, 400, { error: "Missing mcpSlug or channel" });
    return;
  }

  // Get the system.mcp artifact
  const artifact = await deps.getMcpArtifact(channel, mcpSlug);
  if (!artifact) {
    sendJson(res, 404, { error: `system.mcp artifact not found: ${mcpSlug}` });
    return;
  }

  const mcpUrl = artifact.props?.url;
  if (!mcpUrl) {
    sendJson(res, 400, { error: "MCP artifact has no URL configured" });
    return;
  }

  const authConfig = artifact.props?.auth;
  if (authConfig?.type !== "oauth") {
    sendJson(res, 400, {
      error: "MCP artifact does not have OAuth auth configured",
    });
    return;
  }

  try {
    const result = await startOAuthFlow({
      mcpSlug,
      channel,
      mcpUrl,
      authConfig,
      baseUrl: deps.baseUrl,
    });

    sendJson(res, 200, {
      authorizationUrl: result.authorizationUrl,
      state: result.state,
    } as OAuthStartResponse);
  } catch (e) {
    console.error("[oauth] Failed to start OAuth flow:", e);
    sendJson(res, 500, { error: "Failed to start OAuth flow" });
  }
}

/**
 * Handle POST /api/oauth/disconnect
 *
 * Body:
 * - mcpSlug: The system.mcp artifact slug
 * - channel: The channel containing the artifact
 */
export async function handleOAuthDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthApiDependencies
): Promise<void> {
  let body: OAuthDisconnectRequest;
  try {
    body = await parseJsonBody<OAuthDisconnectRequest>(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { mcpSlug, channel } = body;

  if (!mcpSlug || !channel) {
    sendJson(res, 400, { error: "Missing mcpSlug or channel" });
    return;
  }

  // Clear stored tokens
  deps.clearTokens(channel, mcpSlug);

  sendJson(res, 200, { success: true });
}

/**
 * Handle GET /api/oauth/callback
 *
 * Query params:
 * - code: Authorization code
 * - state: State parameter for verification
 * - error: Error code (if authorization failed)
 * - error_description: Error description
 */
export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: OAuthApiDependencies
): Promise<void> {
  const params = {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
    error_description: url.searchParams.get("error_description") ?? undefined,
  };

  try {
    // Validate callback and get pending state
    const { code, pendingState } = validateCallback(params);

    // Exchange code for tokens
    const tokens = await deps.exchangeCodeForTokens(
      pendingState.endpoints.tokenEndpoint,
      code,
      pendingState.codeVerifier,
      pendingState.redirectUri,
      pendingState.clientId
    );

    // Calculate expiry time
    let expiresAt: string | undefined;
    if (tokens.expiresIn) {
      expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    }

    // Store tokens
    deps.storeTokens(
      pendingState.channel,
      pendingState.mcpSlug,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
        scopes: tokens.scope?.split(" "),
      },
      pendingState.mcpUrl
    );

    // Send success response for postMessage
    sendCallbackResponse(res, {
      success: true,
      mcpSlug: pendingState.mcpSlug,
      channel: pendingState.channel,
    });
  } catch (e) {
    if (e instanceof OAuthCallbackError) {
      sendCallbackResponse(res, {
        success: false,
        error: e.code,
        errorDescription: e.message,
      });
    } else {
      console.error("[oauth] Callback error:", e);
      sendCallbackResponse(res, {
        success: false,
        error: "token_exchange_failed",
        errorDescription: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
}

/**
 * Send callback response as HTML page that posts message to opener.
 */
function sendCallbackResponse(
  res: ServerResponse,
  result: {
    success: boolean;
    mcpSlug?: string;
    channel?: string;
    error?: string;
    errorDescription?: string;
  }
): void {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>OAuth Callback</title>
</head>
<body>
  <script>
    const result = ${JSON.stringify(result)};
    if (window.opener) {
      window.opener.postMessage({ type: 'oauth-callback', ...result }, window.location.origin);
      window.close();
    } else {
      document.body.innerHTML = result.success
        ? '<p>Authorization successful. You can close this window.</p>'
        : '<p>Authorization failed: ' + (result.errorDescription || result.error) + '</p>';
    }
  </script>
  <noscript>
    ${
      result.success
        ? "<p>Authorization successful. You can close this window.</p>"
        : `<p>Authorization failed: ${result.errorDescription || result.error}</p>`
    }
  </noscript>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

/**
 * Route OAuth API requests.
 *
 * @returns true if the request was handled, false otherwise
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: OAuthApiDependencies
): Promise<boolean> {
  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    await handleOAuthStatus(req, res, url, deps);
    return true;
  }

  if (url.pathname === "/api/oauth/start" && req.method === "POST") {
    await handleOAuthStart(req, res, deps);
    return true;
  }

  if (url.pathname === "/api/oauth/disconnect" && req.method === "POST") {
    await handleOAuthDisconnect(req, res, deps);
    return true;
  }

  if (url.pathname === "/api/oauth/callback" && req.method === "GET") {
    await handleOAuthCallback(req, res, url, deps);
    return true;
  }

  return false;
}
