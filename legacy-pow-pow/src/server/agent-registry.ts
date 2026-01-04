/**
 * Agent Provider Registry
 *
 * Extensible registry for coding agent providers.
 * Allows runtime registration and lookup of providers by engine name.
 *
 * Usage:
 *   const registry = new ProviderRegistry();
 *   registry.register(new ClaudeProvider());
 *   registry.register(new CodexProvider());
 *
 *   const provider = registry.get("claude");
 *   const engines = registry.list(); // ["claude", "codex"]
 */

import { spawn } from "child_process";
import type { CodingAgentProvider } from "./agent-provider.js";
import {
  type EngineCapabilities,
  type CapabilityManifest,
  BUILTIN_ENGINE_CAPABILITIES,
  isBuiltinEngine,
} from "../shared/engine-capabilities.js";

/** Timeout for --capabilities probe (ms) */
const CAPABILITIES_PROBE_TIMEOUT = 5000;

/**
 * Registry for coding agent providers.
 * Provides registration, lookup, and enumeration of available engines.
 */
export class ProviderRegistry {
  private providers: Map<string, CodingAgentProvider> = new Map();
  private engineCapabilities: Map<string, EngineCapabilities> = new Map();

  /**
   * Register a provider.
   * Provider's `name` property is used as the key.
   *
   * @param provider - Provider instance to register
   * @throws Error if a provider with the same name is already registered
   */
  register(provider: CodingAgentProvider): void {
    const name = provider.name.toLowerCase();
    if (this.providers.has(name)) {
      throw new Error(`Provider "${name}" is already registered`);
    }
    this.providers.set(name, provider);
  }

  /**
   * Get a provider by engine name.
   *
   * @param name - Engine name (case-insensitive)
   * @returns Provider instance or undefined if not found
   */
  get(name: string): CodingAgentProvider | undefined {
    return this.providers.get(name.toLowerCase());
  }

  /**
   * Get a provider by engine name, throwing if not found.
   *
   * @param name - Engine name (case-insensitive)
   * @returns Provider instance
   * @throws Error if provider not found
   */
  getOrThrow(name: string): CodingAgentProvider {
    const provider = this.get(name);
    if (!provider) {
      const available = this.list().join(", ") || "none";
      throw new Error(`Unknown engine "${name}". Available: ${available}`);
    }
    return provider;
  }

  /**
   * Check if a provider is registered.
   *
   * @param name - Engine name (case-insensitive)
   * @returns True if provider exists
   */
  has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  /**
   * List all registered engine names.
   *
   * @returns Array of engine names (lowercase)
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all registered providers.
   *
   * @returns Array of provider instances
   */
  getAll(): CodingAgentProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Unregister a provider.
   *
   * @param name - Engine name to unregister
   * @returns True if provider was unregistered, false if not found
   */
  unregister(name: string): boolean {
    return this.providers.delete(name.toLowerCase());
  }

  /**
   * Clear all registered providers.
   */
  clear(): void {
    this.providers.clear();
  }

  /**
   * Get provider count.
   */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Store capabilities for an engine.
   * Called after successful --capabilities probe.
   */
  setCapabilities(engine: string, capabilities: EngineCapabilities): void {
    this.engineCapabilities.set(engine.toLowerCase(), capabilities);
  }

  /**
   * Get capabilities for an engine.
   * Returns built-in capabilities for claude/codex, or probed capabilities for custom backends.
   */
  getCapabilities(engine: string): EngineCapabilities | undefined {
    const name = engine.toLowerCase();
    // Check built-in first
    if (isBuiltinEngine(name)) {
      return BUILTIN_ENGINE_CAPABILITIES[name];
    }
    // Then check probed capabilities
    return this.engineCapabilities.get(name);
  }

  /**
   * List all engines with their capabilities.
   */
  listEnginesWithCapabilities(): Array<{ engine: string; capabilities: EngineCapabilities }> {
    const result: Array<{ engine: string; capabilities: EngineCapabilities }> = [];
    for (const engine of this.list()) {
      const caps = this.getCapabilities(engine);
      if (caps) {
        result.push({ engine, capabilities: caps });
      }
    }
    return result;
  }
}

/**
 * Default global registry instance.
 * Pre-populated with Claude and Codex providers.
 */
let defaultRegistry: ProviderRegistry | null = null;
let registryInitPromise: Promise<ProviderRegistry> | null = null;

/**
 * Get the default provider registry.
 * Lazily initializes and registers default providers.
 *
 * @param defaultsDir - Optional path to defaults directory for loading external backends
 * @returns Promise resolving to Default ProviderRegistry instance
 */
export async function getDefaultRegistry(defaultsDir?: string): Promise<ProviderRegistry> {
  if (defaultRegistry) {
    return defaultRegistry;
  }
  if (!registryInitPromise) {
    registryInitPromise = createDefaultRegistry(defaultsDir);
  }
  return registryInitPromise;
}

/**
 * Create a new registry with default providers registered.
 *
 * @param defaultsDir - Optional path to defaults directory for loading external backends
 * @returns Promise resolving to new ProviderRegistry with Claude, Codex, and external providers
 */
export async function createDefaultRegistry(defaultsDir?: string): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();

  // Register providers using dynamic imports (ESM-compatible)
  try {
    const { ClaudeProvider } = await import("./providers/claude-provider.js");
    registry.register(new ClaudeProvider());
  } catch (e) {
    console.warn("[registry] Failed to register ClaudeProvider:", e);
  }

  try {
    const { CodexProvider } = await import("./codex-provider.js");
    registry.register(new CodexProvider());
  } catch (e) {
    console.warn("[registry] Failed to register CodexProvider:", e);
  }

  // Register external backends from backends.yaml if defaultsDir provided
  if (defaultsDir) {
    try {
      const { loadBackends } = await import("./defaults.js");
      const backendConfigs = loadBackends(defaultsDir);
      if (backendConfigs.length > 0) {
        await registerExternalBackends(registry, backendConfigs);
        console.error(`[registry] Loaded ${backendConfigs.length} external backend(s)`);
      }
    } catch (e) {
      console.warn("[registry] Failed to load external backends:", e);
    }
  }

  defaultRegistry = registry;
  return registry;
}

/**
 * Reset the default registry.
 * Useful for testing.
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}

/**
 * Convenience export of engine names.
 */
export const DEFAULT_ENGINE = "claude";
export const SUPPORTED_ENGINES = ["claude", "codex"] as const;
export type SupportedEngine = (typeof SUPPORTED_ENGINES)[number];

/**
 * Configuration for registering an external backend.
 */
export interface ExternalBackendConfig {
  /** Unique engine name for this backend */
  name: string;
  /** Path to the binary */
  path: string;
  /** Optional command-line arguments */
  args?: string[];
}

/**
 * Probe a custom backend for its capabilities using --capabilities flag.
 * Returns the capability manifest or throws if probe fails.
 *
 * @param binaryPath - Path to the backend binary
 * @param args - Optional arguments to pass before --capabilities
 * @param timeout - Timeout in milliseconds (default: 5000)
 */
export async function probeBackendCapabilities(
  binaryPath: string,
  args: string[] = [],
  timeout: number = CAPABILITIES_PROBE_TIMEOUT
): Promise<CapabilityManifest> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Capabilities probe timed out after ${timeout}ms for ${binaryPath}`));
    }, timeout);

    let stdout = "";
    let stderr = "";

    const proc = spawn(binaryPath, [...args, "--capabilities"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn ${binaryPath}: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        reject(new Error(
          `Backend ${binaryPath} --capabilities exited with code ${code}. ` +
          `All custom backends must support --capabilities flag.\n` +
          (stderr ? `stderr: ${stderr}` : "")
        ));
        return;
      }

      try {
        const manifest = JSON.parse(stdout.trim()) as CapabilityManifest;
        if (!manifest.engineName || !manifest.capabilities) {
          throw new Error("Invalid manifest: missing engineName or capabilities");
        }
        resolve(manifest);
      } catch (err) {
        reject(new Error(
          `Failed to parse capabilities from ${binaryPath}: ${err instanceof Error ? err.message : err}\n` +
          `stdout: ${stdout}`
        ));
      }
    });
  });
}

/**
 * Register an external backend with the given registry.
 * Probes for capabilities first, then creates an ExternalProvider instance.
 *
 * @param registry - Registry to register with
 * @param config - Backend configuration
 * @throws Error if capabilities probe fails or registration fails
 */
export async function registerExternalBackend(
  registry: ProviderRegistry,
  config: ExternalBackendConfig
): Promise<void> {
  // Probe capabilities first (required for all custom backends)
  console.error(`[registry] Probing capabilities for ${config.name} (${config.path})...`);
  const manifest = await probeBackendCapabilities(config.path, config.args || []);
  console.error(`[registry] Backend ${config.name} capabilities:`, manifest.capabilities);

  // Register the provider
  const { ExternalProvider } = await import("./external-provider.js");
  const provider = new ExternalProvider(config.path, config.args || [], config.name);
  registry.register(provider);

  // Store capabilities
  registry.setCapabilities(config.name, manifest.capabilities);

  console.error(`[registry] Registered external backend: ${config.name} (${config.path})`);
}

/**
 * Register multiple external backends.
 *
 * @param registry - Registry to register with
 * @param configs - Array of backend configurations
 */
export async function registerExternalBackends(
  registry: ProviderRegistry,
  configs: ExternalBackendConfig[]
): Promise<void> {
  for (const config of configs) {
    try {
      await registerExternalBackend(registry, config);
    } catch (e) {
      console.warn(`[registry] Failed to register external backend "${config.name}":`, e);
    }
  }
}
