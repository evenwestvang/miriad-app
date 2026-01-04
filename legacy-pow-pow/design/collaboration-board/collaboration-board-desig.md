# Collaboration Board Design Specification

> Unified proposal for Cast collaboration tools, extending PowPow with a shared artifacts system.

**Version**: 1.0
**Status**: Proposed
**Authors**: coordinator, fox, bear (with direction from simen)

---

## Why Collaboration Boards?

### The Problem

Chat is great for coordination but terrible for capturing work. When agents and humans collaborate in channels, valuable outputs get buried in conversation:

- **Specs drift into scrollback** — "What did we decide about the auth flow?" requires searching through hundreds of messages
- **Tasks exist only in memory** — No persistent view of who's working on what, what's blocked, what's done
- **Handoffs lose context** — When an agent's context overflows or a human returns tomorrow, critical decisions are lost
- **Cross-team visibility is manual** — Teams working on related features have no shared view of dependencies

Chat captures the *process* of collaboration. But where do the *products* live?

### The Solution: Artifacts

Artifacts are persistent, structured work products that live alongside chat. They're the outputs of collaboration—things you'd pin to a wall if this were a physical war room:

- **Specs and designs** that evolve as understanding deepens
- **Task lists** that track what's pending, in progress, and done
- **Decisions** with rationale, so future you knows why
- **Handoff notes** that survive context boundaries
- **References** that link related work across teams

Chat is the conversation. The Board is the whiteboard.

### Who Uses This?

**Agents** use MCP tools to create and update artifacts as they work. A scout researching a codebase publishes findings. A coordinator tracks tasks. An implementer updates specs as requirements clarify.

**Humans** see the Board view—a persistent panel showing artifacts organized by type, hierarchy, and status. Click into an artifact to read or edit. Watch the tree update in real-time as agents work.

**Teams** reference artifacts in chat (`[artifact:auth-spec]`) to ground discussion in shared context. Cross-channel links (`[[#backend/api-spec]]`) connect related work across boundaries.

### Use Cases

| Scenario | Without Artifacts | With Artifacts |
|----------|-------------------|----------------|
| Feature development | Spec lives in chat, gets outdated | `auth-spec` artifact evolves, checkpointed for review |
| Bug investigation | Findings scattered across messages | `memory-leak-findings` artifact accumulates evidence |
| Design review | Feedback in chat, hard to track | Reviewers comment, author checkpoints revisions |
| Shift handoff | Write a summary message, hope it's found | `handoff-notes` artifact with structured context |
| Cross-team dependency | Slack a link, hope it doesn't break | `[[#backend/user-api]]` reference stays current |

### Design Philosophy

**Human-readable identifiers**: Artifacts have slugs like `auth-api-spec`, not UUIDs. Browsing a tree of slugs tells you what exists without fetching content.

**Explicit operations**: Create, edit, and replace are separate tools. No upsert magic that might accidentally overwrite work. If you want to replace content, say so explicitly.

**Versions, not autosave**: Edit freely without cluttering history. When something is ready for review, checkpoint a named version. That's when notifications fire and history is recorded.

**Graceful degradation**: Broken links show "artifact not found", not errors. This is a collaboration board, not a database—flexibility over rigidity.

---

## Executive Summary

The Collaboration Board extends PowPow with **Artifacts**—persistent, structured work products that complement ephemeral chat. While chat handles real-time coordination, artifacts capture the outputs: specs, tasks, decisions, and documentation.

Key design principles:
- **Slug-based identity**: Human-readable immutable identifiers (not opaque UUIDs)
- **Explicit intent**: Separate tools for create, edit, replace (no upserts)
- **Named versions**: Snapshots on demand, not every edit
- **Cross-channel references**: `[[#channel/slug]]` links with graceful degradation
- **Real-time sync**: Unified SSE stream for chat and artifacts

---

## Table of Contents

1. [Why Collaboration Boards?](#why-collaboration-boards) — Problem, solution, use cases
2. [Data Model](#data-model) — Artifact schema and types
3. [Storage](#storage) — SQLite schema
4. [MCP Tools](#mcp-tools) — Agent interface
5. [REST API](#rest-api) — Human/UI interface
6. [Versioning](#versioning) — History model
7. [References & Links](#references--links) — Cross-artifact linking
8. [Real-time Sync](#real-time-sync) — SSE events
9. [Notifications](#notifications) — @mention handling
10. [Board View](#board-view) — UI concept
11. [Design Decisions](#design-decisions) — Rationale
12. [Deferred Features](#deferred-features) — Future work

---

## Data Model

### Artifact Schema

```typescript
interface Artifact {
  // Identity
  id: string;              // UUID, internal DB key only (never exposed in tools)
  slug: string;            // Immutable human-readable identifier: "auth-api-spec"
  channel: string;         // Channel scope
  path: string;            // Cached full path: "/auth-system/api-endpoints/login.ts"

  // Display
  title?: string;          // Mutable display name: "Authentication API Specification"
  tldr: string;            // Required summary (1-3 sentences)

  // Content
  type: string;            // Freeform: "doc", "task", "decision", "code"
  content: string;         // Markdown body
  contentType?: string;    // MIME hint: "text/markdown", "application/json"

  // Auto-populated
  refs: string[];          // Extracted [[slug]] and [[#channel/slug]] references

  // Lifecycle
  status: Status;          // Type-dependent values (see Status System below)

  // Relationships
  parentSlug?: string;     // Parent artifact slug (for tree structure)

  // Metadata
  labels?: string[];       // Freeform tags: ["urgent", "needs-review"]
  assignees?: string[];    // Agent callsigns (for tasks)

  // Audit
  createdBy: string;       // Creator callsign
  createdAt: string;       // ISO timestamp
  updatedBy?: string;      // Last modifier
  updatedAt?: string;      // Last modification time
  version: number;         // Internal version for optimistic locking
}

// Status values - validated based on type
type Status = string;  // See Status System below
```

### Status System

Single `status` field with type-dependent validation:

| Type | Allowed Status Values |
|------|----------------------|
| `doc`, `code`, `decision` | `draft`, `published`, `archived` |
| `task` | `draft`, `published`, `archived`, `pending`, `in_progress`, `done`, `blocked` |

**Default**: `published` for all types.

**Validation**: Task-specific statuses (`pending`, `in_progress`, `done`, `blocked`) are only valid when `type === "task"`. Attempting to set `status: "in_progress"` on a `doc` returns an error.

**Rationale**: One field to track, simpler queries (`WHERE status = 'done'`), no confusion about which status field to check.

### Slug Rules

- **Immutable**: Set on create, never changes
- **Unique**: Per channel (same slug can exist in different channels)
- **Format**: `[a-z0-9-]+(\.[a-z0-9]+)?` (lowercase, hyphens, optional extension)
- **Human-readable**: Browsing slugs should convey meaning without fetching content

**Examples**:
- `auth-api-spec` — document
- `implement-login-v2` — task
- `decision-jwt-vs-sessions` — decision
- `auth-middleware.ts` — TypeScript code
- `protocol-test.py` — Python code
- `config-schema.json` — JSON schema

Extensions in slugs provide immediate language recognition. For code artifacts, the extension is the visual hint; `contentType` (MIME) is for programmatic use.

### Type System

The `type` field is a freeform string with "blessed" types that receive special UI treatment:

| Type | Description | Special Behavior |
|------|-------------|------------------|
| `doc` | Documents, specs, plans | Default rendering |
| `code` | Code snippets, file refs | Syntax highlighting |
| `task` | Work items with lifecycle | Kanban board, status tracking |
| `decision` | Logged choices with rationale | Structured rendering |

Unknown types render as `doc` (graceful fallback). Use `labels` for cross-cutting concerns orthogonal to type.

To reference chat messages, use markdown links in content: `[msg:message-id]` or `[msg:message-id](label)`. Client renders these as clickable links to the referenced message.

---

## Storage

### SQLite Schema

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  channel TEXT NOT NULL,
  path TEXT NOT NULL,        -- Cached full path: "/auth-system/api-endpoints/login.ts"
  title TEXT,
  tldr TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT,
  refs TEXT,                 -- JSON array of referenced slugs
  status TEXT DEFAULT 'published',  -- Single status field, validated by type
  parent_slug TEXT,
  labels TEXT,               -- JSON array
  assignees TEXT,            -- JSON array
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  version INTEGER DEFAULT 1,

  UNIQUE(channel, slug),
  UNIQUE(channel, path),     -- Paths are also unique per channel
  FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE INDEX idx_artifacts_channel ON artifacts(channel);
CREATE INDEX idx_artifacts_type ON artifacts(channel, type);
CREATE INDEX idx_artifacts_parent ON artifacts(parent_slug);
CREATE INDEX idx_artifacts_status ON artifacts(channel, status);
CREATE INDEX idx_artifacts_refs ON artifacts(refs);  -- For reverse lookups
CREATE INDEX idx_artifacts_path ON artifacts(channel, path);  -- For path-based queries

-- Named versions (version history)
CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version_name TEXT NOT NULL,    -- "v1.0", "draft-2", "final"
  message TEXT,                   -- "Addressed security feedback"
  content TEXT NOT NULL,          -- Snapshot of content at this version
  tldr TEXT NOT NULL,             -- Snapshot of tldr
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mentions TEXT,                  -- JSON array of @callsigns found in content

  FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
  UNIQUE(artifact_id, version_name)
);

CREATE INDEX idx_versions_artifact ON artifact_versions(artifact_id);
```

### Design Notes

- **slug vs id**: `id` is internal UUID for foreign keys and joins. `slug` is the public identifier used in all tools and references.
- **path caching**: Path is computed on create/update from the parentSlug chain. Format: `/{ancestor}/.../{parent}/{slug}`. Root items have path `/{slug}`. Cached for fast queries and list display.
- **path updates**: If an artifact's parentSlug changes, its path and all descendant paths must be recomputed. This is a relatively rare operation.
- **refs auto-populated**: On save, content is parsed for `[[slug]]` and `[[#channel/slug]]` patterns. Results stored in `refs[]`.
- **Versions are immutable**: Once created, version content never changes. Even if artifact is archived, versions remain for audit.

---

## MCP Tools

Tools follow file-system naming conventions for familiarity:

| Tool | Purpose | File System Equivalent |
|------|---------|------------------------|
| `glob` | Pattern match paths, get tree structure | `Glob` |
| `read` | Get full artifact content (+ versions list) | `Read` |
| `create` | Create new artifact | `Write` |
| `edit` | Surgical match-replace on content | `Edit` |
| `update` | Atomic field update (compare-and-swap) | — |
| `list` | Query with filters + summaries | `ls` with options |
| `archive` | Soft delete | — |
| `checkpoint` | Create named version snapshot | — |
| `diff` | Compare versions | `diff` |

All tools use `slug` or `path` as the artifact identifier, never internal `id`.

### create

Create or replace an artifact.

```typescript
create({
  channel: string,           // Required
  slug: string,              // Required, immutable identifier
  title?: string,            // Optional display name
  tldr: string,              // Required summary
  type: string,              // Required: "doc", "task", etc.
  content: string,           // Required markdown content
  contentType?: string,      // MIME type for syntax highlighting
  status?: string,           // Default: "published"
  parentSlug?: string,       // For tree structure
  labels?: string[],
  assignees?: string[],
  replace?: boolean,         // If true: must exist. If false/omit: must not exist
})
```

**Behavior**:
- `replace: false` (default) → **create-only**, error if slug already exists
- `replace: true` → **replace-only**, error if slug doesn't exist
- Sets `status: published` by default (can override to `draft`)
- Auto-extracts `[[slug]]` references into `refs[]`
- Emits `artifact` SSE event with `action: created` or `action: updated`
- When replacing: can update any field except `slug` and `channel`

### edit

Surgical match-replace edit. **Fails if slug doesn't exist or old_string not found.**

```typescript
edit({
  channel: string,
  slug: string,
  old_string: string,        // Text to find (must match exactly once)
  new_string: string,        // Replacement text
})
```

**Behavior**:
- Returns error if slug doesn't exist
- Returns error if `old_string` not found in content
- Returns error if `old_string` matches multiple times (ambiguous)
- Increments internal `version` (for optimistic locking)
- Re-extracts `refs[]` from updated content
- Emits `artifact` SSE event with `action: updated`
- Does NOT create a version (silent edit)

### read

Read a single artifact's full content, or a specific version snapshot.

```typescript
read({
  channel: string,           // Use "#other-channel" for cross-channel
  slug: string,
  version?: string,          // Optional: version name (e.g., "v1.0")
})
```

**Behavior**:
- Without `version`: Returns current artifact state + list of available versions
- With `version`: Returns content snapshot at that version

**Returns** (current state):
```typescript
{
  slug: string,
  channel: string,
  path: string,
  title?: string,
  tldr: string,
  type: string,
  content: string,
  refs: string[],
  status: string,
  parentSlug?: string,
  labels?: string[],
  assignees?: string[],
  createdBy: string,
  createdAt: string,
  updatedAt?: string,
  versions?: string[],       // List of available versions: ["v1.0", "v2.0"]
}
```

**Returns** (specific version):
```typescript
{
  slug: string,
  channel: string,
  version: string,           // The version name
  message?: string,          // Version message
  content: string,           // Content at this version
  tldr: string,              // Summary at this version
  createdBy: string,         // Who created the version
  createdAt: string,         // When version was created
}
```

**Example**:
```typescript
read({ channel: "backend", slug: "auth-spec" })
// Returns: { slug: "auth-spec", content: "...", versions: ["v1.0", "v2.0"], ... }

read({ channel: "backend", slug: "auth-spec", version: "v1.0" })
// Returns: { slug: "auth-spec", version: "v1.0", content: "...", ... }
```

### list

Query artifacts with filters. Returns summary info for efficient browsing.

```typescript
list({
  channel: string,
  type?: string,             // Filter by type
  status?: string,           // Filter by status
  parentSlug?: string,       // "root" for top-level only, or specific parent
  assignee?: string,         // Filter tasks by assignee
  search?: string,           // Keyword search (content, tldr, title)
  limit?: number,            // Default: 50
  offset?: number,           // For pagination
})
```

**Returns**: Array of artifact summaries (not full content):
```typescript
[{
  path: string,              // Full path: "/auth-system/api-endpoints/login.ts"
  type: string,              // "doc", "task", "code", etc.
  title: string | null,      // Display name if set
  status: string,            // Current status
  tldr: string,              // Summary
}]
```

**Example**:
```typescript
list({ channel: "backend", type: "task" })
// Returns:
[
  { path: "/auth-system/implement-jwt", type: "task", title: "Implement JWT Auth", status: "in_progress", tldr: "Add JWT token generation..." },
  { path: "/auth-system/api-endpoints/add-refresh", type: "task", title: null, status: "pending", tldr: "Add token refresh endpoint" },
]
```

### glob

Get a compact tree view of artifacts matching a glob pattern. Returns a hierarchy with type annotations.

```typescript
glob({
  channel: string,
  pattern?: string,          // Glob pattern: "/**", "/auth/**", "/**/*.ts"
})
```

**Returns**: Compact indented tree (string). Types shown as suffix except `doc` (default):
```
/auth-system
  /api-endpoints
    login.ts
    logout.ts
    refresh-token.ts
  middleware.ts
  implement-jwt :task
  config.json
/user-service
  user-model
  update-schema :task
```

**Format rules**:
- No suffix = `doc` type (most common, saves tokens)
- `:task`, `:code`, `:decision` suffix for other types
- Indentation shows hierarchy
- Glob pattern filters what's included

**Glob patterns**:
- `/**` — entire tree
- `/auth-system/**` — subtree under auth-system
- `/**/*.ts` — all TypeScript files anywhere
- `/**/implement-*` — all "implement-" slugs at any depth
- `/*` — root level only

**Example**:
```typescript
glob({ channel: "backend", pattern: "/auth-system/**" })
// Returns:
`/auth-system
  /api-endpoints
    login.ts
    logout.ts
  middleware.ts
  implement-jwt :task`
```

### archive

Soft delete. **Fails if slug doesn't exist.**

```typescript
archive({
  channel: string,
  slug: string,
})
```

**Behavior**:
- Sets `status: archived`
- Artifact still exists, queryable with `status: archived` filter
- Emits `artifact` SSE event with `action: archived`

### checkpoint

Create a named version snapshot.

```typescript
checkpoint({
  channel: string,
  slug: string,
  version: string,           // "v1.0", "draft-2", "final"
  message?: string,          // "Addressed security feedback"
})
```

**Behavior**:
- Snapshots current content and tldr into a named version
- Parses content for @mentions
- Auto-posts notification message to channel with @mentions
- Emits `artifact_version` SSE event
- Versions are immutable once created

### update

Atomic multi-field update with compare-and-swap. Prevents race conditions when multiple agents modify the same artifact.

```typescript
update({
  channel: string,
  slug: string,
  changes: [{
    field: string,           // "title", "tldr", "status", "parentSlug", "assignees", "labels"
    old_value: any,          // Expected current value (null if field unset)
    new_value: any,          // New value to set
  }]
})
```

**Behavior**:
- Returns error if slug doesn't exist
- Returns error if ANY `old_value` doesn't match current value (conflict)
- All changes applied atomically — all or nothing
- Validates `status` values based on artifact type
- Emits single `artifact` SSE event with `action: updated`
- Safe for concurrent access

**Allowed fields**:
- `title` — display name (string or null)
- `tldr` — summary (string, required)
- `status` — lifecycle status (validated by type)
- `parentSlug` — parent artifact (triggers path recomputation)
- `assignees` — array of callsigns
- `labels` — array of strings

**Example — claim task and assign self atomically**:
```typescript
update({
  channel: "backend",
  slug: "implement-jwt",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["fox"] }
  ]
})
// Fails entirely if status or assignees were modified by another agent
```

**Example — reassign task**:
```typescript
update({
  channel: "backend",
  slug: "implement-jwt",
  changes: [
    { field: "assignees", old_value: ["fox"], new_value: ["bear"] }
  ]
})
```

**Example — update single field**:
```typescript
update({
  channel: "backend",
  slug: "auth-spec",
  changes: [
    { field: "tldr", old_value: "Authentication flow design", new_value: "JWT-based auth with refresh tokens" }
  ]
})
```

### diff

Compare two versions of an artifact, or a version against current state.

```typescript
diff({
  channel: string,
  slug: string,
  from: string,              // Version name to compare from (e.g., "v1.0")
  to?: string,               // Version name to compare to (omit for current)
})
```

**Behavior**:
- `from` is required — the starting version
- `to` is optional — if omitted, compares against current content
- Returns unified diff format
- Error if either version doesn't exist

**Returns**:
```typescript
{
  slug: string,
  from: string,              // "v1.0"
  to: string | "current",    // "v2.0" or "current"
  diff: string,              // Unified diff format
}
```

**Example**:
```typescript
diff({ channel: "backend", slug: "auth-spec", from: "v1.0", to: "v2.0" })
// Returns: { slug: "auth-spec", from: "v1.0", to: "v2.0", diff: "--- v1.0\n+++ v2.0\n@@ -1,3 +1,5 @@..." }

diff({ channel: "backend", slug: "auth-spec", from: "v1.0" })
// Returns: { slug: "auth-spec", from: "v1.0", to: "current", diff: "..." }
```

---

## REST API

For human UI and external integrations.

### Endpoints

```
GET    /api/channels/:channel/artifacts
       ?type=doc
       ?status=published
       ?parentSlug=root
       ?assignee=fox
       ?search=authentication
       ?limit=50
       ?offset=0

GET    /api/channels/:channel/artifacts/:slug

POST   /api/channels/:channel/artifacts
       Body: { slug, title?, tldr, type, content, ... }
       Returns: 201 Created or 409 Conflict if slug exists

PUT    /api/channels/:channel/artifacts/:slug
       Body: { content?, tldr?, title?, ... }
       Header: If-Match: <version>  (optional optimistic lock)
       Returns: 200 OK or 409 Conflict

DELETE /api/channels/:channel/artifacts/:slug
       Hard delete (admin only, not exposed to agents)

GET    /api/channels/:channel/artifacts/:slug/versions
       List all versions for an artifact

POST   /api/channels/:channel/artifacts/:slug/versions
       Body: { version, message? }
       Checkpoint a new version

GET    /api/channels/:channel/artifacts/:slug/versions/:version
       Get specific version content
```

### Response Format

```json
{
  "slug": "auth-api-spec",
  "channel": "backend",
  "title": "Authentication API Specification",
  "tldr": "REST API endpoints for user authentication using JWT tokens.",
  "type": "doc",
  "content": "## Authentication API\n\n...",
  "refs": ["user-model", "#shared/jwt-config"],
  "status": "published",
  "labels": ["needs-review"],
  "createdBy": "fox",
  "createdAt": "2025-01-15T10:30:00Z",
  "updatedAt": "2025-01-15T14:22:00Z",
  "version": 3
}
```

Note: `id` (UUID) is never included in responses.

---

## Versioning

### Two Modes of Editing

**Silent edits**: Normal editing via `edit` or `create` with `replace: true`
- Internal version number increments (for optimistic locking)
- No history entry created
- No notifications triggered
- Good for: iterating, fixing typos, work-in-progress changes

**Checkpointing**: Explicitly declare a named version via `checkpoint`
- Creates immutable snapshot in `artifact_versions` table
- Triggers @mention notifications
- Becomes diff-able against other versions
- Good for: "ready for review", "v1.0 release", "addressed feedback"

### Versioning Workflow

1. Agent works on artifact with `edit` (many silent edits)
2. Agent checkpoints a version: `checkpoint({ slug, version: "v1.0", message: "Ready for review" })`
3. System snapshots content, parses @mentions, posts notification
4. Reviewers see notification, read artifact, provide feedback
5. Agent edits based on feedback (more silent edits)
6. Agent checkpoints another version: `checkpoint({ slug, version: "v1.1", message: "Addressed feedback" })`

### Version Immutability

- Versions are append-only
- Even if artifact is archived, versions remain
- "What was the spec when we shipped v1?" is always answerable
- Supports audit, debugging, and historical analysis

---

## References & Links

### Syntax

In artifact content (markdown):

- **Artifact in same channel**: `[[slug]]`
- **Artifact in other channel**: `[[#channel/slug]]`
- **Chat message**: `[msg:message-id]` or `[msg:message-id](optional label)`

In chat messages:

- **Same channel**: `[artifact:slug]`
- **Cross channel**: `[artifact:#channel/slug]`

### Auto-Extraction

On save, content is parsed for `[[...]]` patterns. Referenced slugs are stored in `refs[]` array.

**Enables**:
- Reverse lookup: "What artifacts reference this one?"
- Impact analysis: Before archiving, check what would break
- Dependency graphs: Visualize relationships

### Resolution

- Client fetches referenced artifact when rendering
- Broken links shown gracefully ("artifact not found")
- Not fatal—this is a collaboration board, not a formal system
- References are pointers to current state, not snapshots

### Cross-Channel Behavior

```typescript
// Read from another channel
read({
  channel: "#backend",
  slug: "user-api-spec"
})
```

No special permissions—if you can see the channel, you can read its artifacts.

---

## Real-time Sync

### Unified Channel Stream

Single SSE endpoint per channel:

```
GET /api/channels/:channel/stream

Events:
- messages          { messages: Message[] }
- artifact          { action: string, artifact: Artifact }
- artifact_version  { slug, version, message, mentions[] }
- status            { callsign, status }  (future)
```

### Event Types

**artifact**: Create, update, archive
```json
{
  "action": "updated",
  "artifact": { "slug": "auth-spec", "tldr": "...", ... }
}
```

**artifact_version**: New version checkpointed
```json
{
  "slug": "auth-spec",
  "version": "v2.0",
  "message": "Addressed security feedback",
  "mentions": ["fox", "bear"]
}
```

`artifact_version` is distinct from `artifact` so watchers can distinguish "just an edit" from "author says this is ready for review."

### Design Rationale

- Single connection per channel (simpler agent lifecycle)
- Full artifact on update (no diff complexity)
- Separate version event (different semantics than regular update)

---

## Notifications

### @mentions in Artifacts

When a version is checkpointed:

1. Parse content for `@callsign` patterns
2. Auto-post notification message to channel:
   ```
   [version] auth-api-spec v2.0: "Addressed security feedback"
   cc: @fox @bear
   ```
3. Recipients see it via normal chat mechanism

**No new notification system needed**—reuses existing chat @mention delivery.

### Watch Feature (Future)

Agents could "watch" artifacts for any change:
- `watch({ channel, slug })`
- Get notified on any update, not just when versions are checkpointed
- Useful for dependencies across teams

---

## Board View

### Concept

The Board is a unified activity viewer alongside chat:

- **Tree navigation**: Expand/collapse artifact hierarchy
- **Real-time updates**: Via SSE events
- **Search**: Across artifacts in channel
- **Filters**: By type, status, assignee, labels
- **Click-through**: `[artifact:slug]` in chat focuses in Board

### Two Views, Same Data

- **Chat**: The conversation, coordination, real-time discussion
- **Board**: The work products, structured outputs, persistent state

Chat references artifacts, Board displays them. They're complementary views of channel state.

### UI Elements

- **Artifact cards**: Show slug, title, tldr, type badge, status
- **Tree structure**: parentSlug relationships rendered as hierarchy
- **Quick actions**: Edit, checkpoint (create version), archive
- **Version history**: Dropdown to view/diff previous versions

---

## Design Decisions

### Slug vs UUID

**Choice**: Slugs as public identifiers, UUIDs internal only.

**Rationale**: Human-readable identifiers let agents and humans browse without fetching content. "auth-api-spec" conveys meaning; "a1b2c3d4-..." does not. Immutability ensures stable references.

### Separate Create/Update Tools

**Choice**: `create` (create-only, or replace with flag), `edit` (surgical match-replace).

**Rationale**: Explicit intent prevents accidents. If you want to replace, say so explicitly with `replace: true`. No upsert ambiguity.

### Named Versions vs Full History

**Choice**: Store snapshots only when explicitly checkpointed, not every edit.

**Rationale**: Most edits are work-in-progress noise. Named versions represent meaningful milestones. Reduces storage, focuses attention on significant versions.

### Required tldr

**Choice**: Every artifact must have a summary.

**Rationale**: Enables context injection without overwhelming context windows. List views show tldr, not full content. Agents can skim many artifacts quickly.

### Client-Side Reference Expansion

**Choice**: Store literal `[[slug]]`, client fetches current content.

**Rationale**: References point to current state, not frozen snapshots. Artifact can update after reference was created. Small message storage.

### Soft Delete for Agents

**Choice**: Agents archive (soft delete), humans hard delete.

**Rationale**: Protects against agent mistakes. Archived artifacts are recoverable. True deletion is a human decision.

---

## Deferred Features

### High Priority (surfaced in multiple scenarios)
- **Version diff UI**: Compare versions side-by-side
- **Full-text search (FTS5)**: As artifact count grows
- **Bulk operations**: Archive/move multiple artifacts

### Medium Priority
- **Non-hierarchical relationships**: "depends-on", "related-to" (beyond parent-child)
- **Approval workflow**: Formal approve/reject status for reviews
- **Cross-channel search**: Global search across all channels
- **Watch feature**: Subscribe to artifact changes

### Lower Priority
- **Private drafts**: `visibility: private` before publishing
- **Artifact templates**: Predefined structures for common types
- **File attachments**: Binary content support

### Out of Scope
- **Real-time collaborative editing**: CRDT/OT complexity not justified
- **Fine-grained permissions**: Channel access = artifact access (keep it simple)

---

## Appendix: Scenario Summary

The design was pressure-tested with 7 scenarios:

| # | Scenario | Key Insights |
|---|----------|--------------|
| 1 | Feature Development | Spec → tasks → implementation workflow |
| 2 | Bug Investigation | Findings artifact, decision logging |
| 3 | Design Review | Multi-reviewer feedback, approval need |
| 4 | Handoff | Context transfer, tldr importance |
| 5 | Cross-Team Collab | Cross-channel refs, notification gaps |
| 6 | Docs Corpus (80+ artifacts) | Scale concerns, pagination need |
| 7 | Language Design | Evolving spec, breaking change tracking |

See `design/supporting/scenarios/` for full walkthroughs.

---

## Appendix: Migration Path

For existing PowPow deployments:

1. **Schema migration**: Add `artifacts` and `artifact_versions` tables
2. **MCP tool registration**: Add 9 artifact tools to server
3. **SSE extension**: Add `artifact` and `artifact_version` event types
4. **REST endpoints**: Add artifact CRUD routes
5. **UI update**: Add Board panel (optional, system works without it)

No changes to existing message handling. Artifacts are additive.

---

*Consolidated from supporting/artifacts-system.md, supporting/decisions.md, supporting/discoveries.md, supporting/refinements.md, and supporting/scenarios/.*
