/**
 * Mock OAuth Server
 *
 * Implements OAuth 2.1 endpoints for local development and testing.
 * Allows testing the full Sanity OAuth flow without real Sanity credentials.
 *
 * Endpoints:
 * - GET /mock-oauth/authorize - Authorization endpoint (shows login UI, redirects with code)
 * - POST /mock-oauth/token - Token endpoint (exchanges code for mock JWT)
 * - POST /mock-oauth/register - Dynamic client registration (RFC 7591)
 */

import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Storage } from '@cikada/storage';
import type { Space } from '@cikada/core';
import { verifyPKCE } from '../oauth/pkce.js';

// =============================================================================
// Constants
// =============================================================================

/** Pending authorization code TTL in milliseconds (10 minutes) */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Access token expiry in seconds (7 days) */
const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

// =============================================================================
// Types
// =============================================================================

interface PendingAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  userId: string;
  userName: string;
  createdAt: number;
}

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
}

// =============================================================================
// State Management
// =============================================================================

/** Pending authorization codes (in-memory, TTL cleanup) */
const pendingCodes = new Map<string, PendingAuthCode>();

/** Registered clients (in-memory) */
const registeredClients = new Map<string, RegisteredClient>();

/**
 * Clean up expired authorization codes.
 */
function cleanupExpiredCodes(): void {
  const now = Date.now();
  for (const [code, pending] of pendingCodes) {
    if (now - pending.createdAt > CODE_TTL_MS) {
      pendingCodes.delete(code);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredCodes, 5 * 60 * 1000);

// =============================================================================
// JWT Generation
// =============================================================================

/**
 * Generate a mock JWT access token.
 * This is a simplified JWT - not cryptographically signed, just for testing.
 */
function generateMockJwt(userId: string, userName?: string): string {
  const header = {
    alg: 'none',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    name: userName || userId,
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS,
    iss: 'mock-oauth-server',
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Unsigned JWT (alg: none)
  return `${headerB64}.${payloadB64}.`;
}

/**
 * Generate a random authorization code.
 */
function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a random refresh token.
 */
function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// =============================================================================
// Route Handlers
// =============================================================================

export interface MockOAuthHandlerOptions {
  storage: Storage;
  baseUrl: string;
}

/**
 * Handle mock OAuth routes.
 * Returns true if the request was handled, false otherwise.
 */
export async function handleMockOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathParts: string[],
  url: URL,
  options: MockOAuthHandlerOptions
): Promise<boolean> {
  const { storage, baseUrl } = options;

  // POST /mock-oauth/register - Dynamic client registration
  if (req.method === 'POST' && pathParts[1] === 'register') {
    return handleRegister(req, res);
  }

  // GET /mock-oauth/authorize - Authorization endpoint
  if (req.method === 'GET' && pathParts[1] === 'authorize') {
    return handleAuthorize(req, res, url, storage, baseUrl);
  }

  // POST /mock-oauth/token - Token endpoint
  if (req.method === 'POST' && pathParts[1] === 'token') {
    return handleToken(req, res);
  }

  return false;
}

/**
 * Handle dynamic client registration.
 * POST /mock-oauth/register
 */
async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    const body = await parseJsonBody(req);

    const clientId = String(body.client_id || body.client_name || `mock-client-${crypto.randomBytes(6).toString('hex')}`);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : [];
    const clientName = String(body.client_name || clientId);

    // Check if client already registered
    if (registeredClients.has(clientId)) {
      // Already registered - return 409 Conflict (but it's OK)
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'client_already_registered',
        error_description: 'Client ID already registered',
      }));
      return true;
    }

    // Register the client
    registeredClients.set(clientId, {
      clientId,
      redirectUris,
      clientName,
      createdAt: Date.now(),
    });

    console.log(`[MockOAuth] Client registered: ${clientId}`);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }));

    return true;
  } catch (error) {
    console.error('[MockOAuth] Registration error:', error);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'invalid_request',
      error_description: 'Failed to parse registration request',
    }));
    return true;
  }
}

/**
 * Handle authorization request.
 * GET /mock-oauth/authorize
 */
async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  storage: Storage,
  baseUrl: string
): Promise<boolean> {
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const state = url.searchParams.get('state');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';

  // Validate required parameters
  if (!clientId || !redirectUri || responseType !== 'code' || !state || !codeChallenge) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h1>Error</h1><p>Missing or invalid OAuth parameters</p></body></html>`);
    return true;
  }

  // Auto-register client if not already registered (lenient for dev)
  if (!registeredClients.has(clientId)) {
    registeredClients.set(clientId, {
      clientId,
      redirectUris: [redirectUri],
      clientName: clientId,
      createdAt: Date.now(),
    });
    console.log(`[MockOAuth] Auto-registered client: ${clientId}`);
  }

  // Get existing spaces for the login UI
  const spaces = await listAllSpaces(storage);

  // Generate the login page
  const html = generateMockOAuthLoginPage(spaces, {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    baseUrl,
  });

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}

/**
 * Handle token exchange.
 * POST /mock-oauth/token
 */
async function handleToken(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    const body = await parseFormBody(req);

    const grantType = body.grant_type;
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const clientId = body.client_id;
    const codeVerifier = body.code_verifier;

    if (grantType !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant is supported',
      }));
      return true;
    }

    // Find the pending authorization code
    const pending = pendingCodes.get(code);
    if (!pending) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      }));
      return true;
    }

    // Verify client_id matches
    if (pending.clientId !== clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Client ID mismatch',
      }));
      return true;
    }

    // Verify redirect_uri matches
    if (pending.redirectUri !== redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Redirect URI mismatch',
      }));
      return true;
    }

    // Verify PKCE code_verifier
    if (!codeVerifier || !verifyPKCE(codeVerifier, pending.codeChallenge, pending.codeChallengeMethod as 'S256' | 'plain')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid code_verifier',
      }));
      return true;
    }

    // Remove the used code (one-time use)
    pendingCodes.delete(code);

    // Generate tokens
    const accessToken = generateMockJwt(pending.userId, pending.userName);
    const refreshToken = generateRefreshToken();

    console.log(`[MockOAuth] Token issued for user: ${pending.userId}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_EXPIRY_SECONDS,
      refresh_token: refreshToken,
      scope: 'openid profile',
    }));

    return true;
  } catch (error) {
    console.error('[MockOAuth] Token error:', error);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'invalid_request',
      error_description: 'Failed to parse token request',
    }));
    return true;
  }
}

/**
 * Handle the authorization callback (user selected an account).
 * GET /mock-oauth/callback
 */
export async function handleMockOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  storage: Storage
): Promise<boolean> {
  const userId = url.searchParams.get('user');
  const newUser = url.searchParams.get('new');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';

  if (!clientId || !redirectUri || !state || !codeChallenge) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Error</h1><p>Missing OAuth parameters</p></body></html>');
    return true;
  }

  let targetUserId: string;
  let targetUserName: string;

  if (newUser) {
    // Create new user - generate a mock Sanity-style user ID
    targetUserId = `mock-${crypto.randomBytes(8).toString('hex')}`;
    targetUserName = newUser;
    console.log(`[MockOAuth] New user selected: ${targetUserName} (${targetUserId})`);
  } else if (userId) {
    // Use existing user
    const space = await storage.getSpaceByOwnerId(userId);
    if (!space) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>Error</h1><p>User not found: ${userId}</p></body></html>`);
      return true;
    }
    targetUserId = userId;
    targetUserName = space.name || userId;
    console.log(`[MockOAuth] Existing user selected: ${targetUserName} (${targetUserId})`);
  } else {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Error</h1><p>Missing user parameter</p></body></html>');
    return true;
  }

  // Generate authorization code
  const code = generateAuthCode();

  // Store pending authorization
  pendingCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    userId: targetUserId,
    userName: targetUserName,
    createdAt: Date.now(),
  });

  // Redirect back to client with code
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);

  res.writeHead(302, { Location: callbackUrl.toString() });
  res.end();
  return true;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse JSON body from request.
 */
async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Parse form-urlencoded body from request.
 */
async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * List all spaces from storage.
 */
async function listAllSpaces(storage: Storage): Promise<Space[]> {
  // Get all spaces - the storage interface may vary
  try {
    return await storage.listSpaces();
  } catch {
    return [];
  }
}

/**
 * Generate the mock OAuth login page HTML.
 */
function generateMockOAuthLoginPage(
  spaces: Space[],
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    baseUrl: string;
  }
): string {
  const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, baseUrl } = params;

  // Build callback URL with OAuth params
  const callbackBase = `${baseUrl}/mock-oauth/callback`;
  const oauthParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  }).toString();

  const accountsList = spaces
    .filter(space => space.ownerId !== 'system')
    .map(space => {
      const displayName = space.name || space.ownerId;
      return `
        <a href="${callbackBase}?user=${encodeURIComponent(space.ownerId)}&${oauthParams}" class="account">
          <span class="avatar">👤</span>
          <span class="name">${escapeHtml(displayName)}</span>
        </a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Sanity Login - Dev Mode</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #f55449 0%, #f02e20 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 400px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      border-bottom: 1px solid #e9ecef;
    }
    .header h1 {
      font-size: 18px;
      color: #495057;
      font-weight: 600;
    }
    .header .badge {
      display: inline-block;
      background: #f55449;
      color: white;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      margin-top: 6px;
      font-weight: 500;
    }
    .header .client-info {
      font-size: 12px;
      color: #6c757d;
      margin-top: 8px;
    }
    .content {
      padding: 24px;
    }
    .section-title {
      font-size: 13px;
      color: #6c757d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      font-weight: 600;
    }
    .accounts {
      border: 1px solid #e9ecef;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .account {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid #e9ecef;
      text-decoration: none;
      color: #212529;
      transition: background 0.15s;
    }
    .account:last-child {
      border-bottom: none;
    }
    .account:hover {
      background: #f8f9fa;
    }
    .account .avatar {
      font-size: 24px;
      margin-right: 12px;
    }
    .account .name {
      font-size: 14px;
      font-weight: 500;
    }
    .no-accounts {
      padding: 16px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
    .create-form {
      display: flex;
      gap: 8px;
    }
    .create-form input {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid #ced4da;
      border-radius: 6px;
      font-size: 14px;
    }
    .create-form input:focus {
      outline: none;
      border-color: #f55449;
      box-shadow: 0 0 0 3px rgba(245, 84, 73, 0.1);
    }
    .create-form button {
      padding: 10px 16px;
      background: #f55449;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .create-form button:hover {
      background: #f02e20;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Mock Sanity Login</h1>
      <span class="badge">Dev Mode</span>
      <div class="client-info">Authorizing: ${escapeHtml(clientId)}</div>
    </div>
    <div class="content">
      <div class="section-title">Existing accounts</div>
      <div class="accounts">
        ${accountsList || '<div class="no-accounts">No accounts yet</div>'}
      </div>

      <div class="section-title">Or create new</div>
      <form class="create-form" action="${callbackBase}" method="get">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
        <input type="hidden" name="state" value="${escapeHtml(state)}" />
        <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}" />
        <input type="text" name="new" placeholder="Enter username..." required />
        <button type="submit">Login</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =============================================================================
// Exports for Testing
// =============================================================================

export function clearMockOAuthState(): void {
  pendingCodes.clear();
  registeredClients.clear();
}

export function getPendingCodeCount(): number {
  return pendingCodes.size;
}

export function getRegisteredClientCount(): number {
  return registeredClients.size;
}
