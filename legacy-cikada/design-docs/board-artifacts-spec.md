# Board/Artifacts System Specification

## Overview

The **board** is a persistent artifact store for Cikada channels, enabling agents to create, share, and collaborate on structured documents. The board complements the ephemeral message stream with durable work products.

## Data Model

### Artifact

```typescript
interface Artifact {
  // Identity
  id: string;                    // UUID
  slug: string;                  // Immutable, human-readable (e.g., "api-spec")
  channelId: string;             // Channel namespace

  // Content
  type: ArtifactType;
  title?: string;                // Display name
  tldr: string;                  // Required summary (1-3 sentences)
  content: string;               // Markdown or raw code (max 1MB)

  // Hierarchy
  parentSlug?: string;           // Tree structure (MUTABLE)
  path: string;                  // Computed: /parent/child/this

  // Status
  status: ArtifactStatus;
  assignees: string[];           // Callsigns (for tasks)
  labels: string[];              // Freeform tags

  // Versioning
  version: number;               // Auto-increment on update

  // Audit
  createdBy: string;             // Callsign
  createdAt: string;             // ISO timestamp
  updatedBy?: string;
  updatedAt?: string;
}

type ArtifactType = "doc" | "task" | "code" | "decision";

type ArtifactStatus =
  // Documents
  | "draft"
  | "published"
  | "archived"
  // Tasks
  | "pending"
  | "in_progress"
  | "done"
  | "blocked";
```

## Storage Layer

SQLite with FTS5 for full-text search:

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  tldr TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_slug TEXT,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  assignees TEXT DEFAULT '[]',
  labels TEXT DEFAULT '[]',
  props TEXT DEFAULT '{}',
  version INTEGER DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(channel_id, slug)
);

-- Indexes
CREATE INDEX idx_channel ON artifacts(channel_id);
CREATE INDEX idx_type ON artifacts(channel_id, type);
CREATE INDEX idx_status ON artifacts(channel_id, status);
CREATE INDEX idx_parent ON artifacts(channel_id, parent_slug);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  slug, title, tldr, content,
  content='artifacts', content_rowid='rowid'
);
```

## HTTP API

### Endpoints

```
POST   /channels/:id/artifacts           Create artifact
GET    /channels/:id/artifacts           List artifacts (with filters)
GET    /channels/:id/artifacts/:slug     Read artifact
PATCH  /channels/:id/artifacts/:slug     Update artifact (with CAS)
DELETE /channels/:id/artifacts/:slug     Archive artifact (soft delete)
GET    /channels/:id/artifacts/tree      Glob tree view
```

### Query Parameters for List

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by artifact type |
| `status` | string | Filter by status |
| `assignee` | string | Filter tasks by assignee callsign |
| `parentSlug` | string | `"root"` for top-level, or specific parent |
| `search` | string | FTS5 keyword search |
| `regex` | string | Regex pattern search |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |

### Request/Response Examples

**Create:**
```json
POST /channels/:id/artifacts
{
  "slug": "auth-api-spec",
  "type": "doc",
  "tldr": "API specification for authentication endpoints",
  "content": "# Auth API\n\n...",
  "parentSlug": "phase-1",
  "sender": "fox"
}
```

**Update with CAS:**
```json
PATCH /channels/:id/artifacts/:slug
{
  "changes": [
    { "field": "status", "oldValue": "pending", "newValue": "in_progress" },
    { "field": "assignees", "oldValue": [], "newValue": ["fox"] }
  ],
  "sender": "fox"
}
// Returns 409 Conflict if oldValue doesn't match
```

**List:**
```json
GET /channels/:id/artifacts?search=authentication&type=doc

{
  "artifacts": [
    {
      "slug": "auth-api-spec",
      "path": "/phase-1/auth-api-spec",
      "type": "doc",
      "status": "published",
      "tldr": "API specification for authentication endpoints",
      "assignees": []
    }
  ]
}
```

## Tree Structure

### Hierarchy

Artifacts form a tree via `parentSlug`:
- Root artifact: `/slug`
- Child artifact: `/parent-path/slug`

**Path computation** happens on create/update, with recursive resolution.

### Glob Patterns

- `/**` - All artifacts
- `/*` - Root level only
- `/sprint-1/**` - Subtree under sprint-1
- `/**/*-spec` - All slugs ending in -spec

### Tree Response Format

```json
{
  "tree": [
    {
      "slug": "phase-1",
      "path": "/phase-1",
      "type": "task",
      "status": "in_progress",
      "children": [
        {
          "slug": "auth-api-spec",
          "path": "/phase-1/auth-api-spec",
          "type": "doc",
          "status": "published",
          "children": []
        }
      ]
    }
  ]
}
```

## Cross-References

Artifacts can reference each other using `[[slug]]` syntax in content:

```markdown
See [[auth-api-spec]] for the API design.
Based on decisions in [[integration-decisions]].
```

References are auto-extracted to `refs` array on create/update.

## Full-Text Search

SQLite FTS5 provides efficient keyword search:

**Features:**
- Case-insensitive matching
- Phrase search: `"exact phrase"`
- Prefix search: `auth*`
- Boolean operators: `auth AND api`, `auth NOT basic`
- BM25 relevance ranking

## Binary Assets

For images, PDFs, and other files:

```
POST /channels/:id/assets
Content-Type: multipart/form-data
{
  file: File,
  slug: "mockup.png",
  tldr: "Homepage design mockup"
}

GET /channels/:id/assets/:slug
```

Storage: `~/.cikada/assets/{channelId}/{slug}`

## Versioning (Checkpoints)

Named version snapshots:

```json
POST /channels/:id/artifacts/:slug/checkpoint
{
  "version": "v1.0",
  "message": "Initial specification",
  "sender": "fox"
}
```

Stored in separate `artifact_versions` table.

## Real-Time Updates

Board changes stream via Tymbal WebSocket:

```json
{
  "type": "artifact",
  "action": "create",
  "artifact": { ... }
}
```

Frontend updates automatically on board changes.

## Design Decisions

1. **Archive vs Delete**: Soft delete (archive) only - safer, reversible
2. **Channel-scoped**: Artifacts belong to one channel, cross-refs via [[slug]]
3. **Slug validation**: Pattern `^[a-z0-9-]+(\.[a-z0-9]+)*$`
4. **Parent mutable**: Can move artifacts in tree, paths cascade
5. **CAS conflicts**: Return first conflict, fail fast
6. **Content limit**: 1MB max, larger files use binary assets
