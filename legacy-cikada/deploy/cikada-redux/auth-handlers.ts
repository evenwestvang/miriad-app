/**
 * Lambda Auth Handlers
 *
 * Sanity OAuth handlers for AWS Lambda/API Gateway.
 * Adapts the server auth logic for Lambda event/response format.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { SignJWT } from 'jose';
import {
  startSanityAuthFlow,
  handleSanityAuthCallback,
  setAuthStateStorage,
  createDynamoDBAuthStateStorage,
  setOAuthClientStorage,
  createDynamoDBOAuthClientStorage,
} from '@cikada/server';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createDynamoDbStorage } from '@cikada/storage/dynamodb';
import type { Storage, CreateArtifactInput } from '@cikada/storage';
import { ulid } from 'ulid';

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = 'cikada-session';
const SESSION_EXPIRY = '24h';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';

// =============================================================================
// Initialization
// =============================================================================

let initialized = false;
let storage: Storage | null = null;

/**
 * Initialize auth storage and main storage for Lambda.
 * Called once per cold start.
 */
function initStorage(): Storage {
  if (initialized && storage) return storage;

  const authStateTable = process.env.AUTH_STATE_TABLE;
  if (!authStateTable) {
    console.error('[Auth] AUTH_STATE_TABLE not configured');
    throw new Error('AUTH_STATE_TABLE environment variable not set');
  }

  const mainTable = process.env.MAIN_TABLE;
  if (!mainTable) {
    console.error('[Auth] MAIN_TABLE not configured');
    throw new Error('MAIN_TABLE environment variable not set');
  }

  const region = process.env.AWS_REGION || 'us-east-1';

  // Initialize DynamoDB client
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  // Initialize auth state storage (for PKCE state)
  setAuthStateStorage(
    createDynamoDBAuthStateStorage({
      client,
      tableName: authStateTable,
    })
  );

  // Initialize OAuth client storage (for Mellon-assigned client_id)
  setOAuthClientStorage(
    createDynamoDBOAuthClientStorage({
      client,
      tableName: authStateTable, // Reuse same table with different pk prefix
    })
  );

  // Initialize main storage (for spaces, channels, etc.)
  storage = createDynamoDbStorage({
    region,
    tableName: mainTable,
  });

  initialized = true;
  console.log(`[Auth] Storage initialized (authState: ${authStateTable}, main: ${mainTable})`);

  return storage;
}

// =============================================================================
// Helpers
// =============================================================================

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[Auth] WARNING: SESSION_SECRET not set, using insecure default. Set SESSION_SECRET in production!');
    return new TextEncoder().encode(DEFAULT_SECRET);
  }
  return new TextEncoder().encode(secret);
}

function getBaseUrl(event: APIGatewayProxyEventV2): string {
  // Use configured API URL or build from event
  if (process.env.API_URL) {
    return process.env.API_URL;
  }

  const host = event.headers.host || event.requestContext.domainName;
  const protocol = event.headers['x-forwarded-proto'] || 'https';
  const stage = event.requestContext.stage;

  // Check if this is a custom domain request
  // Custom domains map directly to the stage, so no path prefix needed
  // API Gateway default domains include "execute-api" in the host
  const isCustomDomain = host && !host.includes('execute-api');

  if (isCustomDomain) {
    return `${protocol}://${host}`;
  }

  // Include stage in URL for API Gateway HTTP API (stage is a path prefix, not part of domain)
  return `${protocol}://${host}/${stage}`;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  }

  return cookies;
}

async function createSessionToken(userId: string, spaceId: string): Promise<string> {
  return new SignJWT({ spaceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_EXPIRY)
    .sign(getSecret());
}

/**
 * Determine if the request is in a secure context (HTTPS).
 * Used to decide whether to set the Secure flag on cookies.
 */
function isSecureContext(event: APIGatewayProxyEventV2): boolean {
  // Check x-forwarded-proto header (set by API Gateway)
  const forwardedProto = event.headers?.['x-forwarded-proto'];
  if (forwardedProto === 'https') return true;

  // Check origin header
  const origin = event.headers?.origin;
  if (origin?.startsWith('https://')) return true;

  // API Gateway is always HTTPS in production
  // Only return false for explicit localhost/HTTP origins
  const frontendUrl = process.env.FRONTEND_URL || '';
  if (frontendUrl.startsWith('http://localhost')) return false;

  // Default to secure (production)
  return true;
}

function buildSessionCookie(token: string, isSecure: boolean): string {
  const maxAge = 24 * 60 * 60; // 24 hours
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=None',
    // Only set Secure flag for HTTPS contexts - browsers won't send Secure cookies over HTTP
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}

function buildClearSessionCookie(isSecure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=None',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}

function htmlResponse(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html' },
    body,
  };
}

function redirectResponse(location: string, cookies?: string[]): APIGatewayProxyResultV2 {
  return {
    statusCode: 302,
    headers: { Location: location },
    cookies,
  };
}

// =============================================================================
// Space Seeding
// =============================================================================

const ROOT_CHANNEL_NAME = 'root';

/**
 * Default system artifacts to seed.
 * Matches bootstrap-handler.ts for consistency.
 */
function getDefaultArtifacts(rootChannelId: string): Omit<CreateArtifactInput, 'createdBy'>[] {
  return [
    // Open focus area
    {
      slug: 'open',
      channelId: rootChannelId,
      type: 'system.focus',
      title: 'Open',
      tldr: 'Open-ended focus for freeform work and exploration',
      content: `# Open Focus

An open-ended focus area for work that doesn't fit a specific template.

## Default Team
- **Lead** — Coordinates and facilitates whatever needs doing

## When to Use
- Exploratory work without a clear structure
- Ad-hoc tasks and conversations
- Projects that don't fit other focus templates
- General collaboration and planning`,
      status: 'published',
      props: {
        agents: ['lead'],
        defaultTagline: 'Open workspace',
        defaultMission: 'A flexible space for freeform collaboration and exploration.',
      },
    },

    // Board MCP server config
    {
      slug: 'board-mcp',
      channelId: rootChannelId,
      type: 'system.mcp',
      title: 'Board MCP',
      tldr: 'MCP server providing board tools (artifacts, messages) via HTTP transport.',
      content: `This MCP server exposes the Cikada board operations to reactive agents.

Available tools:
- artifact_create, artifact_read, artifact_list, artifact_glob
- artifact_update, artifact_edit, artifact_archive
- message_get, message_search

The URL uses {channelId} placeholder which gets resolved per-channel.`,
      status: 'published',
      props: {
        transport: 'http',
        url: '${CIKADA_API_URL}/mcp/{channelId}',
      },
    },

    // Lead agent definition
    {
      slug: 'lead',
      channelId: rootChannelId,
      type: 'system.agent',
      title: 'Lead',
      tldr: 'Main human touchpoint. Coordinates work, assembles teams.',
      content: `You are the Lead agent - the primary coordinator for this channel.

## Your Role
- Coordinate team activities and delegate tasks
- Break down complex work into actionable items
- Track progress and help resolve blockers
- Facilitate communication between team members and humans
- Assemble and direct specialized agents as needed

## Working Style
- Be proactive about organizing work
- Keep humans informed of progress
- Ask clarifying questions when requirements are unclear
- Use the board (artifacts) to track tasks and decisions`,
      status: 'published',
      props: {
        engine: 'reactive',
        model: 'claude-sonnet-4-20250514',
        agentName: 'lead',
        mcp: [{ slug: 'board-mcp' }],
      },
    },
  ];
}

/**
 * Seed a space with default content (root channel, system artifacts, roster).
 * Idempotent - skips existing artifacts and roster entries.
 */
async function seedSpace(storage: Storage, spaceId: string): Promise<void> {
  console.log(`[Auth] Seeding space ${spaceId}...`);

  // Check if root channel already exists
  let rootChannel = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);

  if (!rootChannel) {
    // Create root channel with lead as the leader
    const rootChannelId = ulid();
    console.log(`[Auth] Creating root channel (id: ${rootChannelId})...`);

    rootChannel = await storage.createChannel(spaceId, {
      id: rootChannelId,
      name: ROOT_CHANNEL_NAME,
      description: 'System channel for focus areas, agent definitions, and playbooks',
      tagline: 'System configuration',
      mission: 'Stores system-level artifacts for focus areas, agent definitions, and shared playbooks.',
      leader: 'lead', // Set lead agent as the channel leader
    });
  } else {
    console.log(`[Auth] Root channel exists (id: ${rootChannel.id})`);
  }

  const rootChannelId = rootChannel.id;

  // Seed default artifacts
  const defaultArtifacts = getDefaultArtifacts(rootChannelId);

  for (const artifactInput of defaultArtifacts) {
    const existing = await storage.getArtifact(spaceId, rootChannelId, artifactInput.slug);

    if (existing) {
      console.log(`[Auth] Artifact "${artifactInput.slug}" exists, skipping`);
      continue;
    }

    console.log(`[Auth] Creating artifact "${artifactInput.slug}"...`);
    await storage.createArtifact(spaceId, rootChannelId, {
      ...artifactInput,
      createdBy: 'system',
    });
  }

  // Seed lead agent to roster (idempotent - check if already exists)
  const existingRoster = await storage.getRoster(spaceId, rootChannelId);
  const leadInRoster = existingRoster.some((r) => r.id === 'lead');

  if (!leadInRoster) {
    console.log(`[Auth] Adding "lead" agent to root channel roster...`);
    await storage.addToRoster(spaceId, rootChannelId, {
      id: 'lead',
      name: 'Lead',
      type: 'agent',
      status: 'idle',
      joinedAt: new Date().toISOString(),
    });
  } else {
    console.log(`[Auth] "lead" agent already in roster, skipping`);
  }

  console.log(`[Auth] Space ${spaceId} seeded successfully`);
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /auth/sanity/login - Start Sanity OAuth flow
 */
export async function authLoginHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    initStorage();

    const baseUrl = getBaseUrl(event);

    // Get return URL from query param or referer
    const returnUrlParam = event.queryStringParameters?.return_url;
    const referer = event.headers.referer;
    const returnUrl = returnUrlParam || referer || undefined;

    console.log(`[Auth] Starting OAuth flow (baseUrl: ${baseUrl}, returnUrl: ${returnUrl})`);

    const { authorizationUrl } = await startSanityAuthFlow(baseUrl, returnUrl);

    console.log(`[Auth] Redirecting to: ${authorizationUrl}`);
    return redirectResponse(authorizationUrl);
  } catch (error) {
    console.error('[Auth] Failed to start OAuth flow:', error);
    return htmlResponse(
      500,
      '<html><body><h1>Error</h1><p>Failed to start authentication</p></body></html>'
    );
  }
}

/**
 * GET /auth/sanity/callback - Handle OAuth callback
 */
export async function authCallbackHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();

    const code = event.queryStringParameters?.code;
    const state = event.queryStringParameters?.state;
    const error = event.queryStringParameters?.error;
    const errorDescription = event.queryStringParameters?.error_description;

    // Check for OAuth error
    if (error) {
      console.error(`[Auth] OAuth error: ${error} - ${errorDescription}`);
      return htmlResponse(
        400,
        `<html><body><h1>Authentication Failed</h1><p>${errorDescription || error}</p></body></html>`
      );
    }

    if (!code || !state) {
      return htmlResponse(
        400,
        '<html><body><h1>Error</h1><p>Missing code or state parameter</p></body></html>'
      );
    }

    console.log(`[Auth] Processing callback (state: ${state.substring(0, 8)}...)`);

    const { userInfo, returnUrl } = await handleSanityAuthCallback(code, state);

    // Get or create space for user (uses DynamoDB storage)
    const space = await storageInstance.getOrCreateSpace(userInfo.userId, userInfo.name);

    // Seed space with default content (idempotent)
    await seedSpace(storageInstance, space.id);

    // Create session token
    const token = await createSessionToken(userInfo.userId, space.id);
    const isSecure = isSecureContext(event);
    const sessionCookie = buildSessionCookie(token, isSecure);

    console.log(`[Auth] User authenticated: ${userInfo.userId} (spaceId: ${space.id})`);

    // Redirect to return URL or frontend
    const defaultFrontendUrl = process.env.FRONTEND_URL || '/';
    const redirectTo = returnUrl || defaultFrontendUrl;

    return redirectResponse(redirectTo, [sessionCookie]);
  } catch (error) {
    console.error('[Auth] Callback error:', error);
    return htmlResponse(
      500,
      '<html><body><h1>Authentication Failed</h1><p>Failed to complete authentication</p></body></html>'
    );
  }
}

/**
 * POST /auth/sanity/logout - Clear session
 */
export async function authLogoutHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const isSecure = isSecureContext(event);
  const clearCookie = buildClearSessionCookie(isSecure);
  const loginUrl = '/auth/sanity/login';

  console.log('[Auth] User logged out');

  return redirectResponse(loginUrl, [clearCookie]);
}

/**
 * GET /auth/me - Get current user info (for frontend)
 *
 * Returns user info and a wsToken for WebSocket authentication.
 * The wsToken is the same JWT from the session cookie — we return it
 * explicitly because browser WebSocket connections can't send cookies
 * cross-origin, so the frontend passes the token in the sync message.
 */
export async function authMeHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cookies = parseCookies(event.cookies?.join('; '));
  const token = cookies[COOKIE_NAME];

  if (!token) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not authenticated' }),
    };
  }

  try {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, getSecret());

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: payload.sub,
        spaceId: payload.spaceId,
        // Include token for WebSocket auth (browsers can't send cookies cross-origin)
        wsToken: token,
      }),
    };
  } catch {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid session' }),
    };
  }
}
