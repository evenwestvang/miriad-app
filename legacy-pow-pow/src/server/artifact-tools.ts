/**
 * Artifact MCP Tools
 *
 * Implements artifact tools per the collaboration board design spec:
 * - glob: Pattern match paths, get tree structure
 * - read: Get full artifact content (+ versions list)
 * - create: Create new artifact (or replace with flag)
 * - edit: Surgical match-replace on content
 * - update: Atomic field update (compare-and-swap)
 * - list: Query with filters + summaries
 * - archive: Soft delete
 * - checkpoint: Create named version snapshot
 * - diff: Compare versions
 * - read_instructions: Documentation for special artifact types
 * - upload_asset: Upload binary files (images, PDFs, etc.) from local filesystem
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { store, Artifact, Status, saveAsset, readAsset, StructuredAskFormData, StructuredAskField, validateFileSizeFromPath, MAX_FILE_SIZE_BYTES } from "./store.js";
import { getJsonSchema, ARTIFACT_PROPS_SCHEMAS, validateArtifactProps } from "../shared/artifact-schemas.js";

// MIME types for common file extensions (convenience lookup, not a whitelist)
// Unknown extensions fall back to application/octet-stream
const MIME_TYPES: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  // Data
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  // Other binary
  wasm: "application/wasm",
  bin: "application/octet-stream",
  exe: "application/octet-stream",
  dll: "application/octet-stream",
  so: "application/octet-stream",
  dylib: "application/octet-stream",
};

// Load instructions from markdown files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const instructionsDir = path.join(__dirname, "../../defaults/instructions");

interface Instruction {
  id: string;
  summary: string;
  content: string;
}

function loadInstructions(): Map<string, Instruction> {
  const instructions = new Map<string, Instruction>();

  if (!fs.existsSync(instructionsDir)) return instructions;

  const files = fs.readdirSync(instructionsDir).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const content = fs.readFileSync(path.join(instructionsDir, file), "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const slug = file.replace(/\.md$/, "");

    if (match) {
      const frontmatter = yaml.load(match[1]) as { summary?: string } || {};
      instructions.set(slug, {
        id: slug,
        summary: frontmatter.summary || slug,
        content: match[2].trim(),
      });
    } else {
      instructions.set(slug, {
        id: slug,
        summary: slug,
        content: content.trim(),
      });
    }
  }

  return instructions;
}

const instructions = loadInstructions();

// Helper: Match a path against a glob pattern (exported for kb-tools)
export function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  let regex = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*");

  // Ensure pattern matches from start
  if (!regex.startsWith("/")) {
    regex = ".*" + regex;
  }

  return new RegExp(`^${regex}$`).test(path);
}

// Helper: Build tree view from artifacts
function buildTreeView(artifacts: Artifact[], pattern: string): string {
  // Filter artifacts by glob pattern
  const filtered = artifacts.filter(a => matchGlob(a.path, pattern));
  if (filtered.length === 0) return "(no artifacts)";

  // Build tree structure
  interface TreeNode {
    name: string;
    type?: string;
    status?: string;
    assignees?: string[];
    children: Map<string, TreeNode>;
  }

  const root: TreeNode = { name: "", children: new Map() };

  for (const artifact of filtered) {
    const parts = artifact.path.split("/").filter(p => p);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
      // Mark type, status, and assignees on leaf nodes
      if (i === parts.length - 1) {
        current.type = artifact.type;
        current.status = artifact.status;
        current.assignees = artifact.assignees;
      }
    }
  }

  // Render tree as indented string
  function render(node: TreeNode, indent: number): string[] {
    const lines: string[] = [];
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      // Directories (nodes with children) first
      const aHasChildren = a.children.size > 0;
      const bHasChildren = b.children.size > 0;
      if (aHasChildren && !bHasChildren) return -1;
      if (!aHasChildren && bHasChildren) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of sortedChildren) {
      const prefix = "  ".repeat(indent);
      const hasChildren = child.children.size > 0;
      const name = hasChildren ? `/${child.name}` : child.name;
      const typeSuffix = child.type && child.type !== "doc" ? ` :${child.type}` : "";
      const statusSuffix = child.status && child.status !== "published" ? ` (${child.status})` : "";
      const assigneesSuffix = child.assignees && child.assignees.length > 0 ? ` @${child.assignees.join(" @")}` : "";
      lines.push(`${prefix}${name}${typeSuffix}${statusSuffix}${assigneesSuffix}`);
      lines.push(...render(child, indent + 1));
    }

    return lines;
  }

  return render(root, 0).join("\n");
}

// Helper: Create unified diff
function createUnifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lines: string[] = [];
  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);

  // Simple line-by-line diff
  let i = 0, j = 0;
  let chunkStart = -1;
  let chunkOld: string[] = [];
  let chunkNew: string[] = [];

  const flushChunk = () => {
    if (chunkOld.length > 0 || chunkNew.length > 0) {
      lines.push(`@@ -${chunkStart + 1},${chunkOld.length} +${chunkStart + 1},${chunkNew.length} @@`);
      chunkOld.forEach(l => lines.push(`-${l}`));
      chunkNew.forEach(l => lines.push(`+${l}`));
      chunkOld = [];
      chunkNew = [];
      chunkStart = -1;
    }
  };

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      flushChunk();
      i++;
      j++;
    } else {
      if (chunkStart === -1) chunkStart = i;
      if (i < oldLines.length) {
        chunkOld.push(oldLines[i]);
        i++;
      }
      if (j < newLines.length) {
        chunkNew.push(newLines[j]);
        j++;
      }
    }
  }
  flushChunk();

  return lines.join("\n");
}

/**
 * Register all artifact MCP tools on the server
 */
export function registerArtifactTools(server: McpServer): void {
  // Tool: glob
  server.tool(
    "glob",
    `Get a compact tree view of artifacts matching a glob pattern. Returns a hierarchy with type annotations.

Patterns:
- "/**" — entire tree
- "/auth-system/**" — subtree under auth-system
- "/**/*.ts" — all TypeScript files anywhere
- "/*" — root level only

Format: Indentation shows hierarchy. Types shown as suffix (:task, :code, :decision) except doc (default).`,
    {
      channel: z.string().describe("Channel name"),
      pattern: z.string().optional().describe("Glob pattern (default: /**)"),
    },
    async ({ channel, pattern }) => {
      const artifacts = store.listArtifacts(channel);
      const tree = buildTreeView(artifacts, pattern || "/**");
      return {
        content: [{ type: "text", text: tree }],
      };
    }
  );

  // Tool: read
  server.tool(
    "read",
    `Read a single artifact's full content, or a specific version snapshot.

Without version: Returns current artifact state + list of available versions.
With version: Returns content snapshot at that version.`,
    {
      channel: z.string().describe("Channel name (use '#other-channel' for cross-channel)"),
      slug: z.string().describe("Artifact slug"),
      version: z.string().optional().describe("Version name (e.g., 'v1.0') to read specific snapshot"),
    },
    async ({ channel, slug, version }) => {
      const actualChannel = channel.startsWith("#") ? channel.slice(1) : channel;

      if (version) {
        const versionData = store.getVersion(actualChannel, slug, version);
        if (!versionData) {
          return {
            isError: true,
            content: [{ type: "text", text: `Version '${version}' not found for artifact '${slug}' in #${actualChannel}` }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(versionData, null, 2) }],
        };
      }

      const artifact = store.getArtifact(actualChannel, slug);
      if (!artifact) {
        return {
          isError: true,
          content: [{ type: "text", text: `Artifact not found: ${slug} in #${actualChannel}` }],
        };
      }

      const versionNames = store.getVersionNames(actualChannel, slug);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...artifact, versions: versionNames }, null, 2),
        }],
      };
    }
  );

  // Tool: create
  server.tool(
    "create",
    `Create or replace an artifact.

- replace: false (default) → create-only, error if slug already exists
- replace: true → replace-only, error if slug doesn't exist
- Sets status: published by default
- Auto-extracts [[slug]] references into refs[]

For code artifacts:
- Content should be RAW CODE only, not wrapped in markdown fences
- Use file extensions in the slug for syntax highlighting:
  - auth-middleware.ts → TypeScript
  - data-processor.py → Python
  - config.json → JSON
  - build-script.sh → Bash

Interactive apps (.app.js):
- Slugs ending in .app.js become runnable apps users can interact with
- Use read_instructions("interactive-artifacts") for the full guide

Binary files (images, PDFs, etc.):
- Use upload_asset tool instead — reads files directly from disk`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens, optional chained extensions (e.g., 'auth.test.ts')").describe("Immutable human-readable identifier (e.g., 'auth-api-spec' or 'auth.test.ts')"),
      title: z.string().optional().describe("Optional display name"),
      tldr: z.string().describe("Required summary (1-3 sentences)"),
      type: z.string().describe("Artifact type: doc (specs, plans, notes), code (snippets, file refs), task (work items with status tracking), decision (logged choices with rationale), system.playbook, system.agent"),
      content: z.string().describe("Content: markdown for docs, raw code for code artifacts (no markdown fences)"),
      contentType: z.string().optional().describe("MIME type hint (e.g., 'text/markdown')"),
      status: z.enum(["draft", "published", "archived", "pending", "in_progress", "done", "blocked"]).optional().describe("Status (default: published)"),
      parentSlug: z.string().optional().describe("Parent artifact slug for tree structure"),
      labels: z.array(z.string()).optional().describe("Freeform tags"),
      assignees: z.array(z.string()).optional().describe("Agent callsigns (for tasks)"),
      props: z.record(z.unknown()).optional().describe("Type-specific properties (e.g., { engine: 'claude', model: 'sonnet' } for system.agent)"),
      replace: z.boolean().optional().describe("If true: must exist. If false/omit: must not exist"),
      sender: z.string().describe("Your callsign (creator)"),
    },
    async ({ channel, slug, title, tldr, type, content, contentType, status, parentSlug, labels, assignees, props, replace, sender }) => {
      const existing = store.getArtifact(channel, slug);

      if (replace === true && !existing) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot replace: artifact '${slug}' does not exist in #${channel}` }],
        };
      }

      if (replace !== true && existing) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot create: artifact '${slug}' already exists in #${channel}. Use replace: true to update.` }],
        };
      }

      // system.focus defaults to draft (requires configuration), others to published
      const defaultStatus = type === "system.focus" ? "draft" : "published";
      const effectiveStatus = (status || defaultStatus) as Status;

      // Pre-validate props for system artifact types - return structured error with schema
      const propsValidationError = validateArtifactProps(type, props);
      if (propsValidationError) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify(propsValidationError, null, 2),
          }],
        };
      }

      try {
        let artifact: Artifact;
        if (replace && existing) {
          // Replace existing artifact
          artifact = store.replaceArtifact(channel, slug, {
            title,
            tldr,
            type,
            content,
            contentType,
            status: effectiveStatus,
            parentSlug,
            orderKey: existing.orderKey,
            labels,
            assignees,
            props,
          }, sender)!;
        } else {
          // Create new artifact
          artifact = store.createArtifact({
            channel,
            slug,
            title,
            tldr,
            type,
            content,
            contentType,
            status: effectiveStatus,
            parentSlug,
            labels,
            assignees,
            props,
            createdBy: sender,
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: existing ? "replaced" : "created",
              artifact,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );

  // Tool: edit
  server.tool(
    "edit",
    `Surgical match-replace edit. Fails if slug doesn't exist or old_string not found/ambiguous.

- Returns error if old_string not found in content
- Returns error if old_string matches multiple times (ambiguous)
- Does NOT create a version (silent edit)`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().describe("Artifact slug"),
      old_string: z.string().describe("Text to find (must match exactly once)"),
      new_string: z.string().describe("Replacement text"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ channel, slug, old_string, new_string, sender }) => {
      const artifact = store.getArtifact(channel, slug);

      if (!artifact) {
        return {
          isError: true,
          content: [{ type: "text", text: `Artifact not found: ${slug} in #${channel}` }],
        };
      }

      // Count matches - must be exactly 1
      const matches = artifact.content.split(old_string).length - 1;

      if (matches === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `old_string not found in artifact content. The content may have changed, or try including more context.` }],
        };
      }

      if (matches > 1) {
        return {
          isError: true,
          content: [{ type: "text", text: `old_string matches ${matches} times - ambiguous. Include more surrounding context to make it unique.` }],
        };
      }

      const newContent = artifact.content.replace(old_string, new_string);
      store.updateArtifact(channel, slug, {
        content: newContent,
        updatedBy: sender,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "edited",
            slug,
            channel,
            updatedBy: sender,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: update
  server.tool(
    "update",
    `Atomic multi-field update with compare-and-swap. Prevents race conditions.

All changes applied atomically — all or nothing.
Returns error if ANY old_value doesn't match current value (conflict).

For bulk updates, provide 'slugs' array instead of 'slug'. Same changes applied to all.
All artifacts must pass CAS validation or entire operation fails.

Allowed fields: title, tldr, status, parentSlug, assignees, labels, props

To move an artifact in the tree, update 'parentSlug' (use null for root level).`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().optional().describe("Single artifact slug (use 'slugs' for bulk)"),
      slugs: z.array(z.string()).optional().describe("Multiple artifact slugs for bulk update"),
      changes: z.array(z.object({
        field: z.string().describe("Field name: title, tldr, status, parentSlug, assignees, labels, props"),
        old_value: z.unknown().describe("Expected current value (null if field unset)"),
        new_value: z.unknown().describe("New value to set"),
      })).describe("Array of field changes with compare-and-swap"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ channel, slug, slugs, changes, sender }) => {
      // Determine which slugs to update
      const targetSlugs = slugs && slugs.length > 0 ? slugs : (slug ? [slug] : []);

      if (targetSlugs.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Either 'slug' or 'slugs' must be provided" }],
        };
      }

      // Phase 1: Validate all artifacts exist and CAS checks pass
      const artifactsToUpdate: Array<{ slug: string; artifact: any; updates: Record<string, unknown> }> = [];

      for (const targetSlug of targetSlugs) {
        const artifact = store.getArtifact(channel, targetSlug);

        if (!artifact) {
          return {
            isError: true,
            content: [{ type: "text", text: `Artifact not found: ${targetSlug} in #${channel}` }],
          };
        }

        // Validate all old_values match
        const updates: Record<string, unknown> = {};
        for (const change of changes) {
          const currentValue = (artifact as any)[change.field] ?? null;
          const expectedValue = change.old_value ?? null;

          // Deep comparison for arrays
          const currentStr = JSON.stringify(currentValue);
          const expectedStr = JSON.stringify(expectedValue);

          if (currentStr !== expectedStr) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: `Compare-and-swap conflict on '${targetSlug}' field '${change.field}': expected ${expectedStr}, got ${currentStr}`,
              }],
            };
          }

          updates[change.field] = change.new_value;
        }

        artifactsToUpdate.push({ slug: targetSlug, artifact, updates });
      }

      // Phase 2: Apply all updates (all CAS checks passed)
      try {
        const results = [];
        for (const { slug: targetSlug, updates } of artifactsToUpdate) {
          const updated = store.updateArtifact(channel, targetSlug, {
            ...updates,
            updatedBy: sender,
          } as any);
          results.push(updated);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "updated",
              count: results.length,
              artifacts: results,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );

  // Tool: list
  server.tool(
    "list",
    `Query artifacts with filters. Returns summary info (path, type, title, status, tldr, assignees) - not full content.

Use 'search' for basic keyword matching, or 'regex' for pattern matching (e.g., 'auth.*spec').`,
    {
      channel: z.string().describe("Channel name"),
      type: z.string().optional().describe("Filter by type"),
      status: z.string().optional().describe("Filter by status"),
      parentSlug: z.string().optional().describe("'root' for top-level only, or specific parent slug"),
      assignee: z.string().optional().describe("Filter tasks by assignee"),
      search: z.string().optional().describe("Keyword search (slug, title, tldr, content)"),
      regex: z.string().optional().describe("Regex pattern search (slug, title, tldr, content)"),
      limit: z.number().optional().describe("Default: 50"),
      offset: z.number().optional().describe("For pagination"),
    },
    async ({ channel, type, status, parentSlug, assignee, search, regex, limit, offset }) => {
      const artifacts = store.listArtifacts(channel, {
        type,
        status: status as Status,
        parentSlug: parentSlug === "root" ? null : parentSlug,
        assignee,
        search,
        regex,
        limit: limit || 50,
        offset: offset || 0,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(artifacts.map(a => ({
            path: a.path,
            type: a.type,
            title: a.title || null,
            status: a.status,
            tldr: a.tldr,
            assignees: a.assignees || [],
          })), null, 2),
        }],
      };
    }
  );

  // Tool: archive
  server.tool(
    "archive",
    `Soft delete. Sets status to 'archived'. Artifact still exists, queryable with status: archived filter.`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().describe("Artifact slug"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ channel, slug, sender }) => {
      const success = store.archiveArtifact(channel, slug, sender);

      if (!success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Artifact not found: ${slug} in #${channel}` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "archived",
            channel,
            slug,
            archivedBy: sender,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: checkpoint
  server.tool(
    "checkpoint",
    `Create a named version snapshot.

- Snapshots current content and tldr
- Parses content for @mentions
- Auto-posts notification message to channel
- Versions are immutable once created`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().describe("Artifact slug"),
      version: z.string().describe("Version name (e.g., 'v1.0', 'draft-2', 'final')"),
      message: z.string().optional().describe("Version message (e.g., 'Addressed security feedback')"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ channel, slug, version, message, sender }) => {
      try {
        const versionData = store.createVersion(channel, slug, version, message, sender);
        if (!versionData) {
          return {
            isError: true,
            content: [{ type: "text", text: `Artifact not found: ${slug} in #${channel}` }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "checkpointed",
              slug,
              version,
              message,
              mentions: versionData.mentions,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );

  // Tool: diff
  server.tool(
    "diff",
    `Compare two versions of an artifact, or a version against current state.

- from is required — the starting version
- to is optional — if omitted, compares against current content
- Returns unified diff format`,
    {
      channel: z.string().describe("Channel name"),
      slug: z.string().describe("Artifact slug"),
      from: z.string().describe("Version name to compare from (e.g., 'v1.0')"),
      to: z.string().optional().describe("Version name to compare to (omit for current)"),
    },
    async ({ channel, slug, from, to }) => {
      const fromVersion = store.getVersion(channel, slug, from);
      if (!fromVersion) {
        return {
          isError: true,
          content: [{ type: "text", text: `Version '${from}' not found for artifact '${slug}'` }],
        };
      }

      let toContent: string;
      let toLabel: string;

      if (to) {
        const toVersion = store.getVersion(channel, slug, to);
        if (!toVersion) {
          return {
            isError: true,
            content: [{ type: "text", text: `Version '${to}' not found for artifact '${slug}'` }],
          };
        }
        toContent = toVersion.content;
        toLabel = to;
      } else {
        const artifact = store.getArtifact(channel, slug);
        if (!artifact) {
          return {
            isError: true,
            content: [{ type: "text", text: `Artifact not found: ${slug}` }],
          };
        }
        toContent = artifact.content;
        toLabel = "current";
      }

      const diff = createUnifiedDiff(fromVersion.content, toContent, from, toLabel);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            slug,
            from,
            to: toLabel,
            diff,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: read_instructions
  // Build description dynamically from loaded instructions
  const articleList = Array.from(instructions.values())
    .map(i => `- ${i.id}: ${i.summary}`)
    .join("\n");

  const articleIds = Array.from(instructions.keys());

  server.tool(
    "read_instructions",
    `Read documentation for special artifact types and capabilities.

Available articles:
${articleList || "(no instructions available)"}`,
    {
      article: z.string().describe("Article ID to read"),
    },
    async ({ article }) => {
      const instruction = instructions.get(article);

      if (!instruction) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Unknown article: ${article}\n\nAvailable: ${articleIds.join(", ") || "(none)"}`,
          }],
        };
      }

      return {
        content: [{ type: "text", text: instruction.content }],
      };
    }
  );

  // Tool: upload_asset
  server.tool(
    "upload_asset",
    `Upload a binary file from the local filesystem as an artifact asset.

Use this to share images, PDFs, or other binary files generated during your work.
The file is stored in ~/.cast/assets/ and served via /boards/:channel/:slug

Examples:
- Screenshot: upload_asset(channel: "design", path: "/tmp/screenshot.png", slug: "mockup.png", tldr: "UI mockup v2")
- Diagram: upload_asset(channel: "arch", path: "./diagram.svg", slug: "system-diagram.svg", tldr: "System architecture")
- Generated chart: upload_asset(channel: "data", path: "/tmp/chart.png", slug: "q4-metrics.png", tldr: "Q4 performance chart")`,
    {
      channel: z.string().describe("Channel name"),
      path: z.string().describe("Local file path to upload (absolute or relative to cwd)"),
      slug: z.string().regex(/^[a-z0-9-]+\.[a-z0-9]+$/, "Slug must be lowercase with extension (e.g., 'logo.png')").describe("Artifact slug with file extension"),
      tldr: z.string().describe("Brief description of the asset"),
      title: z.string().optional().describe("Optional display name"),
      parentSlug: z.string().optional().describe("Parent artifact for tree structure"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ channel, path: filePath, slug, tldr, title, parentSlug, sender }) => {
      // Resolve the file path
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

      // Check file exists
      if (!fs.existsSync(resolvedPath)) {
        return {
          isError: true,
          content: [{ type: "text", text: `File not found: ${resolvedPath}` }],
        };
      }

      // Read file stats
      const stats = fs.statSync(resolvedPath);
      if (stats.isDirectory()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Path is a directory, not a file: ${resolvedPath}` }],
        };
      }

      // Validate file size before reading
      const sizeValidation = validateFileSizeFromPath(resolvedPath);
      if (!sizeValidation.valid) {
        return {
          isError: true,
          content: [{ type: "text", text: sizeValidation.error! }],
        };
      }

      // Check if slug already exists
      const existing = store.getArtifact(channel, slug);
      if (existing) {
        return {
          isError: true,
          content: [{ type: "text", text: `Artifact with slug '${slug}' already exists in #${channel}` }],
        };
      }

      // Determine content type from extension (fallback to application/octet-stream)
      const ext = slug.split(".").pop()?.toLowerCase();
      const contentType = ext && MIME_TYPES[ext] ? MIME_TYPES[ext] : "application/octet-stream";

      try {
        // Read and save the file
        const data = fs.readFileSync(resolvedPath);
        saveAsset(channel, slug, data);

        // Create artifact record with encoding: "file"
        const artifact = store.createArtifact({
          channel,
          slug,
          title,
          tldr,
          type: "code",  // Assets show as code type with binary handling
          content: "",   // Content is stored in file system
          contentType,
          encoding: "file",
          status: "published",
          parentSlug,
          createdBy: sender,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "uploaded",
              artifact: {
                slug: artifact.slug,
                channel: artifact.channel,
                path: artifact.path,
                contentType,
                size: stats.size,
                url: `/boards/${channel}/${slug}`,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to upload asset: ${err.message}` }],
        };
      }
    }
  );

  // Tool: copy_artifact
  server.tool(
    "copy_artifact",
    `Copy an artifact from one channel to another.

- Creates a full copy (not a reference)
- Preserves type, content, props, and metadata
- Does NOT copy assignees (new channel, new team)
- No link back to original — it's a fork

Common use case: Copy system artifacts from #root to your channel for customization.`,
    {
      from_channel: z.string().describe("Source channel (e.g., 'root')"),
      slug: z.string().describe("Artifact slug to copy"),
      to_channel: z.string().describe("Destination channel"),
      new_slug: z.string().optional().describe("Optional: rename in destination (defaults to same slug)"),
      sender: z.string().describe("Your callsign"),
    },
    async ({ from_channel, slug, to_channel, new_slug, sender }) => {
      try {
        const artifact = store.copyArtifact(from_channel, slug, to_channel, new_slug, sender);

        if (!artifact) {
          return {
            isError: true,
            content: [{ type: "text", text: `Artifact not found: ${slug} in #${from_channel}` }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "copied",
              from: { channel: from_channel, slug },
              to: { channel: to_channel, slug: artifact.slug },
              artifact,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );

  // Tool: update_channel_info
  server.tool(
    "update_channel_info",
    `Update channel tagline and/or mission.

Use this to update the channel's tagline (short label) and/or mission (longer description).
Updates are broadcast to the channel as a system message.

- tagline: Short label for the channel (what we're working on)
- mission: Longer description (how we're approaching it)

At least one of tagline or mission must be provided.`,
    {
      channel: z.string().describe("Channel name"),
      sender: z.string().describe("Your callsign"),
      tagline: z.string().optional().describe("New tagline (short label)"),
      mission: z.string().optional().describe("New mission (longer description)"),
    },
    async ({ channel, sender, tagline, mission }) => {
      // Validate at least one field provided
      if (!tagline && !mission) {
        return {
          isError: true,
          content: [{ type: "text", text: "At least one of tagline or mission must be provided" }],
        };
      }

      // Check channel exists
      const channelData = store.getChannel(channel);
      if (!channelData) {
        return {
          isError: true,
          content: [{ type: "text", text: `Channel not found: ${channel}` }],
        };
      }

      // Update metadata
      const updates: { tagline?: string; mission?: string } = {};
      const updated: string[] = [];

      if (tagline !== undefined) {
        updates.tagline = tagline;
        updated.push("tagline");
      }
      if (mission !== undefined) {
        updates.mission = mission;
        updated.push("mission");
      }

      store.updateChannelMetadata(channel, updates);

      // Post system message
      if (tagline) {
        store.addMessage(channel, "system", `Channel updated: "${tagline}"`);
      } else if (mission) {
        // Truncate mission at ~80 chars
        const truncated = mission.length > 80 ? mission.slice(0, 77) + "..." : mission;
        store.addMessage(channel, "system", `Channel mission: "${truncated}"`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            updated,
            channel,
            updatedBy: sender,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: list_focus_types
  server.tool(
    "list_focus_types",
    `List available focus types for new channel creation.

Returns all published system.focus artifacts from #root.
Use this to populate the focus picker UI when creating a new channel.

Each focus type has:
- slug: Used in channel creation API
- title: Human-readable display name
- tldr: Brief description of the focus

Results are ordered by their orderKey in #root (admin-controlled display order).`,
    {},
    async () => {
      const focusTypes = store.listArtifacts("root", {
        type: "system.focus",
        status: "published",
      });

      const result = focusTypes.map(f => ({
        slug: f.slug,
        title: f.title || f.slug,
        tldr: f.tldr,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // Tool: list_summonable_agent_types
  server.tool(
    "list_summonable_agent_types",
    `List agent types that can be summoned to this channel.

Returns available agent definitions (system.agent artifacts) that aren't already in the channel roster.
Use this to populate summon_request fields in structured_ask forms.

Each agent type has:
- slug: Used in spawn directives (@name+slug)
- name: Human-readable display name
- engine: AI provider (claude, openai, etc.)`,
    {
      channel: z.string().describe("Channel to list available agents for"),
    },
    async ({ channel }) => {
      try {
        const agents = store.listAvailableAgentTypes(channel);

        // Return simplified format for UI consumption
        const result = agents.map(a => ({
          slug: a.slug,
          name: a.name,
          engine: a.engine || "claude",
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              channel,
              availableAgents: result,
              count: result.length,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );

  // Tool: get_artifact_props_schema
  server.tool(
    "get_artifact_props_schema",
    `Get the JSON Schema for props of a specific artifact type.

Returns the schema that defines valid props for system artifact types.
Use this to understand what fields are required/optional when creating artifacts.

Supported types: ${Object.keys(ARTIFACT_PROPS_SCHEMAS).join(", ")}`,
    {
      type: z.string().describe("Artifact type (e.g., 'system.mcp', 'system.agent')"),
    },
    async ({ type }) => {
      const schema = getJsonSchema(type);

      if (!schema) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `No schema defined for artifact type '${type}'.\n\nSupported types: ${Object.keys(ARTIFACT_PROPS_SCHEMAS).join(", ")}`,
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            type,
            propsSchema: schema,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: structured_ask
  server.tool(
    "structured_ask",
    `Post a structured form in the chat for humans to respond to.

Use this instead of free-form text questions when you need:
- Yes/no confirmations
- Multiple choice selections
- Bounded text input

The form appears inline in chat. When submitted, you'll receive the response as a message @mentioning you.

Field types:
- radio: Single select from options
- checkbox: Multi-select from options
- select: Dropdown single select
- text: Single-line text input
- textarea: Multi-line text input
- summon_request: Proposed agents for human approval (use agents array, not options)

For summon_request fields, provide an 'agents' array with your proposed team:
\`\`\`json
{
  "id": "team",
  "type": "summon_request",
  "label": "Proposed team",
  "description": "The specialists needed for this task",
  "agents": [
    { "callsign": "fox", "definitionSlug": "engineer", "purpose": "Frontend React components" },
    { "callsign": "bear", "definitionSlug": "engineer", "purpose": "Backend API" }
  ]
}
\`\`\`

Use list_summonable_agent_types to see available agent definitions for definitionSlug values.`,
    {
      channel: z.string().describe("Channel to post the form in"),
      sender: z.string().describe("Your callsign"),
      prompt: z.string().describe("The question/prompt text shown above the form"),
      to: z.array(z.string()).optional().default([]).describe("Array of callsigns who should respond (renders as @mentions). Omit or empty for anyone to submit."),
      fields: z.array(z.object({
        id: z.string().describe("Unique identifier for this field"),
        label: z.string().describe("Display label"),
        description: z.string().optional().describe("Optional help text"),
        type: z.enum(["radio", "checkbox", "text", "textarea", "select", "summon_request"]).describe("Field type"),
        options: z.array(z.object({
          value: z.string(),
          label: z.string(),
        })).optional().describe("Options for radio/checkbox/select fields"),
        agents: z.array(z.object({
          callsign: z.string().describe("Proposed callsign for this agent (e.g., 'fox')"),
          definitionSlug: z.string().describe("Agent type from list_summonable_agent_types (e.g., 'engineer')"),
          purpose: z.string().describe("What this agent will do in this project"),
        })).optional().describe("Proposed agents for summon_request fields"),
        required: z.boolean().optional().describe("Whether field is required"),
        placeholder: z.string().optional().describe("Placeholder for text/textarea fields"),
      })).describe("Array of form fields"),
      submitLabel: z.string().optional().describe("Custom submit button text (default: 'Submit')"),
    },
    async ({ channel, sender, prompt, to, fields, submitLabel }) => {
      try {
        // Validate: radio/checkbox/select must have options
        for (const field of fields) {
          if (["radio", "checkbox", "select"].includes(field.type) && (!field.options || field.options.length === 0)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Field "${field.id}" (${field.type}) requires options` }],
            };
          }
          // Validate: summon_request must have agents array
          if (field.type === "summon_request" && (!field.agents || field.agents.length === 0)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Field "${field.id}" (summon_request) requires agents array with at least one proposed agent` }],
            };
          }
        }

        const formData: StructuredAskFormData = {
          prompt,
          fields: fields as StructuredAskField[],
          submitLabel,
          to,
        };

        const message = store.addStructuredAsk(channel, sender, formData);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "structured_ask_created",
              messageId: message.id,
              channel: message.channel,
              prompt: message.content,
              to,
              fieldCount: fields.length,
              note: "Form posted. You'll receive the response as a message when submitted.",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
    }
  );
}
