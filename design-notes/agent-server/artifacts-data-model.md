# Artifacts Data Model

## Overview

Artifacts are the primary persistence mechanism for collaborative work products in Cikada. Each channel has an associated **board** — a hierarchical collection of artifacts that outlive chat messages. Artifacts store specs, tasks, decisions, code snippets, and system configuration.

## Core Entity: Artifact

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (ULID) | Yes | Unique identifier, auto-generated |
| `slug` | string | Yes | Human-readable immutable identifier (e.g., `auth-api-spec`, `config.json`) |
| `channelId` | string | Yes | Channel this artifact belongs to |
| `type` | ArtifactType | Yes | Classification of the artifact |
| `title` | string | No | Optional display name |
| `tldr` | string | Yes | 1-3 sentence summary (always required) |
| `content` | string | Yes | Main body — markdown for docs, raw code for code artifacts |
| `parentSlug` | string | No | Parent artifact slug for tree hierarchy |
| `path` | string | Yes | Computed hierarchical path (e.g., `/planning/phase-1/setup-repo`) |
| `status` | ArtifactStatus | Yes | Current lifecycle state |
| `assignees` | string[] | No | Agent callsigns (primarily for tasks) |
| `labels` | string[] | No | Freeform tags |
| `refs` | string[] | No | Auto-extracted `[[slug]]` references |
| `props` | Record | No | Type-specific structured properties |
| `version` | number | Yes | Optimistic concurrency version counter |
| `createdBy` | string | Yes | Creator's callsign |
| `createdAt` | string (ISO) | Yes | Creation timestamp |
| `updatedBy` | string | No | Last updater's callsign |
| `updatedAt` | string (ISO) | No | Last update timestamp |

### Artifact Types

```typescript
type ArtifactType =
  | 'doc'              // Specs, plans, notes, documentation (default)
  | 'task'             // Work items with status tracking
  | 'code'             // Code snippets, file references (syntax highlighted)
  | 'decision'         // Logged choices with rationale
  | 'knowledgebase'    // KB root marker for semantic search
  | 'system.mcp'       // MCP server configuration
  | 'system.agent'     // Agent definition
  | 'system.focus'     // Channel template/focus type
  | 'system.playbook'; // Workflow guidelines
```

### Artifact Statuses

Statuses are overloaded based on artifact type:

**Document-oriented** (`doc`, `code`, `decision`):
- `draft` — Work in progress, not finalized
- `published` — Ready for consumption (default)
- `archived` — Soft-deleted, hidden from default views

**Task-oriented** (`task`):
- `pending` — Not yet started
- `in_progress` — Currently being worked on
- `done` — Completed successfully
- `blocked` — Cannot proceed, waiting on dependency

### Default Status by Type

| Type | Default Status |
|------|----------------|
| `doc`, `code`, `decision` | `published` |
| `task` | `pending` |
| `system.*` | `published` |

## Tree Structure

Artifacts form a tree hierarchy via `parentSlug`. The `path` field is computed automatically:

```
/planning                    (parentSlug: null)
  /phase-1                   (parentSlug: planning)
    /setup-repo              (parentSlug: phase-1)
    /setup-ci                (parentSlug: phase-1)
  /phase-2                   (parentSlug: planning)
```

Path computation logic (from `packages/storage/src/sqlite/index.ts:869`):
1. If no `parentSlug`, path is `/{slug}`
2. If `parentSlug` exists, path is `{parent.path}/{slug}`

## System Artifact Props Schemas

System artifacts (`system.*` types) have validated `props` schemas:

### system.mcp

Configures an MCP server for agent tool access:

```typescript
interface SystemMcpProps {
  transport: 'stdio' | 'sse' | 'http';
  
  // stdio transport
  command?: string;      // e.g., 'npx', 'node'
  args?: string[];
  env?: Record<string, string>;  // ${VAR} syntax for server env refs
  cwd?: string;
  
  // http/sse transport
  url?: string;
  headers?: Record<string, string>;
  auth?: OAuthConfig;    // OAuth 2.1 with PKCE
  
  capabilities?: string; // Human description
}
```

> **Known Issue:** The Zod validation schema in `artifact-schemas.ts` only allows `'stdio' | 'http'`, but runtime types in `handlers/src/agents/types.ts` and `core/src/cikada/channels.ts` support `'sse'` as well. SSE transport will fail schema validation but work at runtime. This should be fixed in a clean implementation.

### system.agent

Defines an agent type that can be spawned:

```typescript
interface SystemAgentProps {
  engine: string;           // 'claude', 'codex', etc.
  model?: string;           // e.g., 'claude-sonnet-4-20250514'
  nameTheme?: string;       // For generating callsigns
  agentName?: string;       // Fixed name for singletons
  mcp?: McpReference[];     // Array of { slug: string }
}
```

### system.focus

Channel template configuration:

```typescript
interface SystemFocusProps {
  agents: string[];         // Agent slugs to spawn on channel creation
  defaultTagline?: string;
  defaultMission?: string;
  initialPrompt?: string;   // Sent when channel is created
}
```

## Code References

- Data model interface: `packages/storage/src/interface.ts:49-115`
- SQLite schema: `packages/storage/src/sqlite/index.ts:1416-1462`
- Props validation: `packages/server/src/artifact-schemas.ts`
- Handler types: `packages/handlers/src/artifacts/types.ts`

