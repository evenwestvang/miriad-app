/**
 * Credentials Module (Stage 3)
 *
 * Handles reading/writing server credentials from ~/.config/cast/credentials.json
 * and API interactions for bootstrap exchange and agent token requests.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ServerCredentials,
  BootstrapResponse,
  AgentTokenResponse,
  ParsedConnectionString,
} from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

const CREDENTIALS_DIR = join(homedir(), ".config", "cast");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

// ============================================================================
// Connection String Parsing
// ============================================================================

/**
 * Parse a CAST connection string.
 * Format: cast://<token>@<host>/<spaceId>
 * Examples:
 *   cast://bst_abc123@api.cast.dev/space_xyz
 *   cast://bootstrap_abc123@api.cast.dev/space_xyz
 */
export function parseConnectionString(connectionString: string): ParsedConnectionString {
  // Expected format: cast://<token>@<host>/<spaceId>
  // Token can be bst_xxx (actual backend format) or bootstrap_xxx (legacy)
  const match = connectionString.match(
    /^cast:\/\/([^@]+)@([^/]+)\/(.+)$/
  );

  if (!match) {
    throw new Error(
      `Invalid connection string format. Expected: cast://<token>@<host>/<spaceId>`
    );
  }

  const [, bootstrapToken, host, spaceId] = match;

  return {
    host,
    bootstrapToken,
    spaceId,
  };
}

// ============================================================================
// Credentials Storage
// ============================================================================

/**
 * Load server credentials from disk.
 * Returns null if no credentials file exists.
 */
export async function loadCredentials(): Promise<ServerCredentials | null> {
  try {
    const content = await readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content) as ServerCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Save server credentials to disk.
 * Creates the config directory if it doesn't exist.
 */
export async function saveCredentials(credentials: ServerCredentials): Promise<void> {
  // Ensure directory exists
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });

  // Write credentials with restricted permissions
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
    mode: 0o600, // Owner read/write only
  });
}

/**
 * Delete stored credentials.
 */
export async function deleteCredentials(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(CREDENTIALS_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

// ============================================================================
// API Interactions
// ============================================================================

/**
 * Determine protocol based on host.
 * Uses http:// for localhost/127.0.0.1, https:// for everything else.
 */
function getProtocol(host: string): string {
  const hostname = host.split(":")[0].toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http";
  }
  return "https";
}

/**
 * Exchange a bootstrap token for server credentials.
 */
export async function exchangeBootstrapToken(
  host: string,
  bootstrapToken: string
): Promise<BootstrapResponse> {
  const protocol = getProtocol(host);
  const url = `${protocol}://${host}/api/local-agents/bootstrap`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bootstrapToken }),
  });

  if (!response.ok) {
    if (response.status === 400) {
      throw new Error("Invalid bootstrap token format.");
    }
    if (response.status === 401) {
      throw new Error("Bootstrap token is invalid or expired.");
    }
    if (response.status === 409) {
      throw new Error("Bootstrap token has already been used.");
    }
    throw new Error(`Bootstrap exchange failed: ${response.statusText}`);
  }

  return (await response.json()) as BootstrapResponse;
}

/**
 * Request an agent token from CAST.
 */
export async function requestAgentToken(
  credentials: ServerCredentials,
  channelId: string,
  callsign: string
): Promise<string> {
  const protocol = getProtocol(credentials.host);
  const url = `${protocol}://${credentials.host}/api/local-agents/agent-token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Server ${credentials.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channelId, callsign }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Server credentials invalid or expired. Run 'init' again.");
    }
    if (response.status === 403) {
      throw new Error(`Channel ${channelId} is not accessible from this space.`);
    }
    if (response.status === 404) {
      throw new Error(`Channel ${channelId} not found.`);
    }
    throw new Error(`Failed to get agent token: ${response.statusText}`);
  }

  const data = (await response.json()) as AgentTokenResponse;
  return data.token;
}

// ============================================================================
// Init Flow
// ============================================================================

/**
 * Initialize server credentials from a connection string.
 * Parses the string, exchanges the bootstrap token, and saves credentials.
 */
export async function initFromConnectionString(
  connectionString: string
): Promise<ServerCredentials> {
  // Parse connection string
  const parsed = parseConnectionString(connectionString);

  console.log(`[Init] Connecting to ${parsed.host}...`);

  // Exchange bootstrap token for credentials
  const response = await exchangeBootstrapToken(parsed.host, parsed.bootstrapToken);

  // Create credentials object
  const credentials: ServerCredentials = {
    serverId: response.serverId,
    secret: response.secret,
    spaceId: response.spaceId,
    host: response.host,
    wsHost: response.wsHost,
    createdAt: new Date().toISOString(),
  };

  // Save to disk
  await saveCredentials(credentials);

  console.log(`[Init] Credentials saved to ${CREDENTIALS_FILE}`);
  console.log(`[Init] Server ID: ${credentials.serverId}`);
  console.log(`[Init] Space: ${credentials.spaceId}`);

  return credentials;
}
