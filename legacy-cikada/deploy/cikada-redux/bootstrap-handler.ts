/**
 * Lambda Bootstrap Handler
 *
 * Seeds a space with system artifacts (focus areas, agent definitions).
 * Single source of truth for seeding logic shared with local dev.
 *
 * POST /bootstrap - Seeds the authenticated user's space
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { jwtVerify } from 'jose';
import { createDynamoDbStorage } from '@cikada/storage/dynamodb';
import type { Storage, CreateArtifactInput } from '@cikada/storage';
import { ulid } from 'ulid';

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = 'cikada-session';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';
const ROOT_CHANNEL_NAME = 'root';

// =============================================================================
// Initialization
// =============================================================================

let storage: Storage | null = null;

function initStorage(): Storage {
  if (storage) return storage;

  const mainTable = process.env.MAIN_TABLE;
  if (!mainTable) {
    console.error('[Bootstrap] MAIN_TABLE not configured');
    throw new Error('MAIN_TABLE environment variable not set');
  }

  const region = process.env.AWS_REGION || 'us-east-1';

  storage = createDynamoDbStorage({
    region,
    tableName: mainTable,
  });

  console.log(`[Bootstrap] Storage initialized (table: ${mainTable})`);
  return storage;
}

// =============================================================================
// Auth Helpers
// =============================================================================

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[Bootstrap] WARNING: SESSION_SECRET not set, using insecure default');
    return new TextEncoder().encode(DEFAULT_SECRET);
  }
  return new TextEncoder().encode(secret);
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

interface SessionPayload {
  userId: string;
  spaceId: string;
}

async function verifySession(event: APIGatewayProxyEventV2): Promise<SessionPayload> {
  const cookies = parseCookies(event.cookies?.join('; '));
  const token = cookies[COOKIE_NAME];

  if (!token) {
    throw new Error('No session token');
  }

  const { payload } = await jwtVerify(token, getSecret());

  if (!payload.sub || !payload.spaceId) {
    throw new Error('Invalid session payload');
  }

  return {
    userId: payload.sub,
    spaceId: payload.spaceId as string,
  };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return jsonResponse(statusCode, { error: message });
}

// =============================================================================
// Seed Data - Single Source of Truth
// =============================================================================

/**
 * Default system artifacts to seed.
 * This is the canonical definition shared between local dev and AWS.
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

// =============================================================================
// Seeding Logic
// =============================================================================

interface SeedResult {
  rootChannelId: string;
  created: string[];
  skipped: string[];
}

/**
 * Seed a space with system artifacts.
 * Idempotent - skips artifacts that already exist.
 */
async function seedSpace(storage: Storage, spaceId: string): Promise<SeedResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Check if root channel already exists
  let rootChannel = await storage.getChannelByName(spaceId, ROOT_CHANNEL_NAME);

  if (!rootChannel) {
    // Create root channel
    const rootChannelId = ulid();
    console.log(`[Seed] Creating root channel for space ${spaceId} (id: ${rootChannelId})...`);

    rootChannel = await storage.createChannel(spaceId, {
      id: rootChannelId,
      name: ROOT_CHANNEL_NAME,
      description: 'System channel for focus areas, agent definitions, and playbooks',
      tagline: 'System configuration',
      mission: 'Stores system-level artifacts for focus areas, agent definitions, and shared playbooks.',
    });

    created.push(`channel:${ROOT_CHANNEL_NAME}`);
  } else {
    console.log(`[Seed] Root channel exists for space ${spaceId} (id: ${rootChannel.id})`);
    skipped.push(`channel:${ROOT_CHANNEL_NAME}`);
  }

  const rootChannelId = rootChannel.id;

  // Seed default artifacts
  const defaultArtifacts = getDefaultArtifacts(rootChannelId);

  for (const artifactInput of defaultArtifacts) {
    const existing = await storage.getArtifact(spaceId, rootChannelId, artifactInput.slug);

    if (existing) {
      console.log(`[Seed] Artifact "${artifactInput.slug}" already exists, skipping`);
      skipped.push(`artifact:${artifactInput.slug}`);
      continue;
    }

    console.log(`[Seed] Creating artifact "${artifactInput.slug}"...`);
    await storage.createArtifact(spaceId, rootChannelId, {
      ...artifactInput,
      createdBy: 'system',
    });
    created.push(`artifact:${artifactInput.slug}`);
  }

  console.log(`[Seed] Space ${spaceId} seeded: ${created.length} created, ${skipped.length} skipped`);

  return { rootChannelId, created, skipped };
}

// =============================================================================
// Handler
// =============================================================================

/**
 * POST /bootstrap
 *
 * Seeds the authenticated user's space with system artifacts.
 * Idempotent - safe to call multiple times.
 */
export async function bootstrapHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  console.log('[Bootstrap] Received request');

  try {
    const db = initStorage();
    const session = await verifySession(event);

    console.log(`[Bootstrap] User ${session.userId}, space ${session.spaceId}`);

    const result = await seedSpace(db, session.spaceId);

    return jsonResponse(200, {
      success: true,
      spaceId: session.spaceId,
      rootChannelId: result.rootChannelId,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message === 'No session token' || message === 'Invalid session payload') {
      console.error('[Bootstrap] Auth error:', message);
      return errorResponse(401, 'Unauthorized');
    }

    console.error('[Bootstrap] Error:', error);
    return errorResponse(500, message);
  }
}
