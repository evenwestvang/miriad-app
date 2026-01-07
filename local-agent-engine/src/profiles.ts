/**
 * Environment Profiles Module (Stage 4)
 *
 * Auto-detects environment from host, with optional profile config overrides.
 * Handles protocol selection (http/https, ws/wss) based on environment.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export type Environment = "local" | "staging";

export interface EnvironmentConfig {
  apiProtocol: "http" | "https";
  wsProtocol: "ws" | "wss";
}

export interface Profile {
  name: string;
  apiHost: string;
  wsHost: string;
  environment: Environment;
}

export interface ProfilesConfig {
  profiles: Record<string, Profile>;
  defaultProfile?: string;
}

// ============================================================================
// Configuration
// ============================================================================

const PROFILES_DIR = join(homedir(), ".config", "cast-local-agent");
const PROFILES_FILE = join(PROFILES_DIR, "profiles.json");

// Default profiles
const DEFAULT_PROFILES: ProfilesConfig = {
  profiles: {
    local: {
      name: "local",
      apiHost: "localhost:3234",
      wsHost: "localhost:3234",
      environment: "local",
    },
    staging: {
      name: "staging",
      apiHost: "staging.clanker.is",
      wsHost: "ws.staging.clanker.is",
      environment: "staging",
    },
  },
  defaultProfile: "local",
};

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Auto-detect environment from host string.
 *
 * Rules:
 *   *.staging.clanker.is → staging
 *   Everything else      → local
 */
export function detectEnvironment(host: string): Environment {
  const hostname = host.split(":")[0].toLowerCase();

  if (hostname.endsWith(".staging.clanker.is") || hostname === "staging.clanker.is") {
    return "staging";
  }

  return "local";
}

/**
 * Get protocol configuration for an environment.
 */
export function getEnvironmentConfig(env: Environment): EnvironmentConfig {
  switch (env) {
    case "staging":
      return { apiProtocol: "https", wsProtocol: "wss" };
    case "local":
    default:
      return { apiProtocol: "http", wsProtocol: "ws" };
  }
}

/**
 * Get API protocol for a host (auto-detect environment).
 */
export function getApiProtocol(host: string): "http" | "https" {
  const env = detectEnvironment(host);
  return getEnvironmentConfig(env).apiProtocol;
}

/**
 * Get WebSocket protocol for a host (auto-detect environment).
 */
export function getWsProtocol(host: string): "ws" | "wss" {
  const env = detectEnvironment(host);
  return getEnvironmentConfig(env).wsProtocol;
}

/**
 * Build full API URL from host.
 */
export function buildApiUrl(host: string): string {
  const protocol = getApiProtocol(host);
  return `${protocol}://${host}`;
}

/**
 * Build full WebSocket URL from host.
 */
export function buildWsUrl(host: string, path: string = ""): string {
  const protocol = getWsProtocol(host);
  return `${protocol}://${host}${path}`;
}

// ============================================================================
// Profile Storage
// ============================================================================

/**
 * Load profiles config from disk.
 * Returns default profiles if no config file exists.
 */
export async function loadProfiles(): Promise<ProfilesConfig> {
  try {
    const content = await readFile(PROFILES_FILE, "utf-8");
    const loaded = JSON.parse(content) as ProfilesConfig;
    // Merge with defaults to ensure all default profiles exist
    return {
      profiles: { ...DEFAULT_PROFILES.profiles, ...loaded.profiles },
      defaultProfile: loaded.defaultProfile ?? DEFAULT_PROFILES.defaultProfile,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_PROFILES;
    }
    throw error;
  }
}

/**
 * Save profiles config to disk.
 */
export async function saveProfiles(config: ProfilesConfig): Promise<void> {
  await mkdir(dirname(PROFILES_FILE), { recursive: true });
  await writeFile(PROFILES_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/**
 * Get a profile by name.
 * Falls back to default profile if name not found.
 */
export async function getProfile(name?: string): Promise<Profile | null> {
  const config = await loadProfiles();

  if (name && config.profiles[name]) {
    return config.profiles[name];
  }

  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return config.profiles[config.defaultProfile];
  }

  return null;
}

/**
 * Add or update a custom profile.
 */
export async function setProfile(profile: Profile): Promise<void> {
  const config = await loadProfiles();
  config.profiles[profile.name] = profile;
  await saveProfiles(config);
}

/**
 * Set the default profile.
 */
export async function setDefaultProfile(name: string): Promise<void> {
  const config = await loadProfiles();
  if (!config.profiles[name]) {
    throw new Error(`Profile '${name}' does not exist`);
  }
  config.defaultProfile = name;
  await saveProfiles(config);
}

/**
 * List all available profiles.
 */
export async function listProfiles(): Promise<Profile[]> {
  const config = await loadProfiles();
  return Object.values(config.profiles);
}

// ============================================================================
// Resolve Configuration
// ============================================================================

export interface ResolvedConfig {
  apiHost: string;
  wsHost: string;
  apiProtocol: "http" | "https";
  wsProtocol: "ws" | "wss";
  environment: Environment;
  source: "auto-detect" | "profile" | "cli";
}

/**
 * Resolve final configuration from multiple sources.
 *
 * Priority (highest to lowest):
 *   1. CLI flags (--ws-host, --api-host)
 *   2. Profile override (--profile)
 *   3. Connection string host (auto-detect from stored credentials)
 *   4. Default profile
 *
 * @param options Configuration options
 * @returns Resolved configuration with all hosts and protocols
 */
export async function resolveConfig(options: {
  wsHost?: string;
  apiHost?: string;
  profile?: string;
  credentialsHost?: string;
}): Promise<ResolvedConfig> {
  const { wsHost, apiHost, profile, credentialsHost } = options;

  // 1. CLI flags take precedence
  if (wsHost || apiHost) {
    const host = wsHost ?? apiHost ?? "localhost:3234";
    const env = detectEnvironment(host);
    const envConfig = getEnvironmentConfig(env);

    return {
      apiHost: apiHost ?? host,
      wsHost: wsHost ?? host,
      apiProtocol: envConfig.apiProtocol,
      wsProtocol: envConfig.wsProtocol,
      environment: env,
      source: "cli",
    };
  }

  // 2. Profile override
  if (profile) {
    const p = await getProfile(profile);
    if (p) {
      const envConfig = getEnvironmentConfig(p.environment);
      return {
        apiHost: p.apiHost,
        wsHost: p.wsHost,
        apiProtocol: envConfig.apiProtocol,
        wsProtocol: envConfig.wsProtocol,
        environment: p.environment,
        source: "profile",
      };
    }
    console.warn(`[Profiles] Profile '${profile}' not found, falling back to auto-detect`);
  }

  // 3. Auto-detect from credentials host
  if (credentialsHost) {
    const env = detectEnvironment(credentialsHost);
    const envConfig = getEnvironmentConfig(env);

    return {
      apiHost: credentialsHost,
      wsHost: credentialsHost,
      apiProtocol: envConfig.apiProtocol,
      wsProtocol: envConfig.wsProtocol,
      environment: env,
      source: "auto-detect",
    };
  }

  // 4. Default profile
  const defaultProfile = await getProfile();
  if (defaultProfile) {
    const envConfig = getEnvironmentConfig(defaultProfile.environment);
    return {
      apiHost: defaultProfile.apiHost,
      wsHost: defaultProfile.wsHost,
      apiProtocol: envConfig.apiProtocol,
      wsProtocol: envConfig.wsProtocol,
      environment: defaultProfile.environment,
      source: "profile",
    };
  }

  // Fallback to local
  return {
    apiHost: "localhost:3234",
    wsHost: "localhost:3234",
    apiProtocol: "http",
    wsProtocol: "ws",
    environment: "local",
    source: "auto-detect",
  };
}
