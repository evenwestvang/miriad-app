import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";
import { store } from "./store.js";
import { type ExternalBackendConfig } from "./agent-registry.js";

const CAST_DIR = process.env.CAST_DIR || process.env.POWPOW_DIR || path.join(os.homedir(), ".cast");

interface MarkdownFrontmatter {
  name?: string;
  slug?: string;
  nameTheme?: string;
  agentName?: string;
  engine?: string;
  model?: string;
}

interface BackendsYaml {
  backends?: Record<string, {
    path: string;
    args?: string[];
  }>;
}

function parseMarkdownWithFrontmatter(content: string): { frontmatter: MarkdownFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const frontmatter = yaml.load(match[1]) as MarkdownFrontmatter || {};
  const body = match[2].trim();
  return { frontmatter, body };
}

/**
 * Load backends from a single backends.yaml file.
 * Returns a Map for easy merging.
 * Relative paths are resolved against the config file location.
 */
function loadBackendsFromFile(filePath: string): Map<string, ExternalBackendConfig> {
  const configs = new Map<string, ExternalBackendConfig>();

  if (!fs.existsSync(filePath)) {
    return configs;
  }

  const configDir = path.dirname(filePath);
  const content = fs.readFileSync(filePath, "utf-8");
  const data = yaml.load(content) as BackendsYaml;

  if (!data?.backends) {
    return configs;
  }

  for (const [name, config] of Object.entries(data.backends)) {
    // Resolve relative paths against config file location
    // Only resolve paths starting with ./ or ../ (not commands like "npx")
    const resolvedPath = config.path.startsWith('./') || config.path.startsWith('../')
      ? path.resolve(configDir, config.path)
      : config.path;

    // Also resolve relative paths in args (e.g., script paths for npx/node)
    const resolvedArgs = config.args?.map(arg => {
      // Only resolve args that look like relative paths (start with ./ or ../)
      if (arg.startsWith('./') || arg.startsWith('../')) {
        return path.resolve(configDir, arg);
      }
      return arg;
    });

    configs.set(name, {
      name,
      path: resolvedPath,
      args: resolvedArgs,
    });
  }

  return configs;
}

/**
 * Load external backend configurations from backends.yaml files.
 * Checks both bundled defaults and user config, with user config taking precedence.
 *
 * Load order:
 * 1. defaults/backends.yaml - bundled defaults
 * 2. ~/.cast/backends.yaml - user-defined backends (overrides defaults on conflict)
 *
 * Relative paths in each config are resolved against that config file's location.
 */
export function loadBackends(defaultsDir: string): ExternalBackendConfig[] {
  // Load bundled defaults first
  const defaultsFile = path.join(defaultsDir, "backends.yaml");
  const configs = loadBackendsFromFile(defaultsFile);

  // Load user config and merge (user wins on conflict)
  const userFile = path.join(CAST_DIR, "backends.yaml");
  const userConfigs = loadBackendsFromFile(userFile);
  for (const [name, config] of userConfigs) {
    configs.set(name, config);
  }

  return Array.from(configs.values());
}

/**
 * Legacy seedDefaults function - now a no-op.
 * Agent definitions are now stored as artifacts in #root via seedRootArtifacts.
 */
export function seedDefaults(_defaultsDir: string, _force = false): void {
  // Legacy hats/playbooks/templates are no longer used.
  // Agent definitions are seeded to #root as system.agent artifacts.
  // See seedRootArtifacts() for the new seeding mechanism.
}

/**
 * Seed the #root channel with system.agent artifacts from hat files.
 * These become the default agent templates that can be copied to other channels.
 */
export function seedRootArtifacts(defaultsDir: string, force = false): void {
  // Always try to seed - the per-file check handles duplicates
  console.error("[powpow] Checking #root for missing system artifacts...");

  // Load hats from defaults
  const hatsDir = path.join(defaultsDir, "hats");
  if (!fs.existsSync(hatsDir)) {
    console.error("[powpow] No hats directory found, skipping agent seed");
    return;
  }

  const files = fs.readdirSync(hatsDir).filter(f => f.endsWith(".md"));
  let seeded = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(hatsDir, file), "utf-8");
    const { frontmatter, body } = parseMarkdownWithFrontmatter(content);
    const fileSlug = file.replace(/\.md$/, "");
    const slug = frontmatter.slug || fileSlug;

    // Skip if this agent already exists
    const existing = store.getArtifact("root", slug);
    if (existing) {
      console.error(`[powpow] Skipping ${slug} - already exists`);
      continue;
    }

    // Build props from frontmatter
    const props: Record<string, unknown> = {
      engine: frontmatter.engine || "claude",  // Default to claude engine
    };

    // Add optional props
    if (frontmatter.nameTheme) {
      props.nameTheme = frontmatter.nameTheme;
    }
    if (frontmatter.agentName) {
      props.agentName = frontmatter.agentName;
    }
    if (frontmatter.model) {
      props.model = frontmatter.model;
    }

    // Create the system.agent artifact
    store.createArtifact({
      channel: "root",
      slug,
      title: frontmatter.name || slug,
      tldr: `System agent: ${frontmatter.name || slug}`,
      type: "system.agent",
      content: body,
      status: "published",
      props,
      createdBy: "system",
    });

    seeded++;
    console.error(`[powpow] Seeded agent: ${slug}`);
  }

  console.error(`[powpow] Seeded ${seeded} agents to #root`);
}

/**
 * Migration for channel agents from hatId to agentSlug is now handled
 * directly in the database layer (store.ts) during schema initialization.
 * This function is kept as a no-op for backward compatibility with startup code.
 */
export function migrateChannelAgentsToSlugs(): void {
  // Migration is handled in store.ts DB initialization
}
