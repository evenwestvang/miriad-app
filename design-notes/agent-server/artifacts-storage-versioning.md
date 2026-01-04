# Artifacts Storage & Versioning

## Storage Backends

The storage layer is abstracted via the `Storage` interface (`packages/storage/src/interface.ts`), with two implementations:

| Backend | Use Case | Location |
|---------|----------|----------|
| SQLite | Local development | `packages/storage/src/sqlite/` |
| DynamoDB | AWS production | `packages/storage/src/dynamodb/` |

This spec focuses on SQLite as the reference implementation.

---

## SQLite Schema

### artifacts table

```sql
CREATE TABLE artifacts (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  tldr TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_slug TEXT,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  assignees TEXT NOT NULL DEFAULT '[]',    -- JSON array
  labels TEXT NOT NULL DEFAULT '[]',       -- JSON array
  refs TEXT NOT NULL DEFAULT '[]',         -- JSON array
  props TEXT,                              -- JSON object
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (space_id, channel_id, slug)
);

-- Indexes
CREATE INDEX idx_artifacts_space_channel ON artifacts(space_id, channel_id);
CREATE INDEX idx_artifacts_type ON artifacts(space_id, channel_id, type);
CREATE INDEX idx_artifacts_status ON artifacts(space_id, channel_id, status);
CREATE INDEX idx_artifacts_path ON artifacts(space_id, channel_id, path);
```

**Code reference:** `packages/storage/src/sqlite/index.ts:1416-1444`

### artifact_versions table

```sql
CREATE TABLE artifact_versions (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  version_name TEXT NOT NULL,
  version_message TEXT,
  version_created_at TEXT NOT NULL,
  version_created_by TEXT NOT NULL,
  tldr TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (space_id, channel_id, slug, version_name),
  FOREIGN KEY (space_id, channel_id, slug) 
    REFERENCES artifacts(space_id, channel_id, slug)
);

CREATE INDEX idx_artifact_versions_artifact 
  ON artifact_versions(space_id, channel_id, slug);
```

**Code reference:** `packages/storage/src/sqlite/index.ts:1447-1462`

---

## Versioning System

### Optimistic Concurrency

Each artifact has a `version` integer that increments on every update. This enables:
- Detecting concurrent modifications
- CAS (Compare-and-Swap) operations for safe concurrent updates

### Named Version Snapshots (Checkpoints)

Checkpoints create immutable snapshots for review/rollback:

```typescript
interface ArtifactVersion {
  slug: string;
  versionName: string;      // e.g., "v1.0", "draft-2", "final"
  versionMessage?: string;  // e.g., "Addressed security feedback"
  versionCreatedAt: string;
  versionCreatedBy: string;
  tldr: string;             // Snapshot of tldr at checkpoint time
  content: string;          // Snapshot of content at checkpoint time
}
```

**Checkpoint Flow:**
1. Call `checkpointArtifact(spaceId, channelId, slug, versionName, message, createdBy)`
2. Current `tldr` and `content` are copied to `artifact_versions`
3. Version is immutable once created
4. Can diff between versions via `artifact_diff` (compares snapshots)

**Code reference:** `packages/storage/src/sqlite/index.ts:1224-1254`

---

## Knowledge Base Integration

Artifacts can be indexed for semantic search when organized under a `knowledgebase` parent:

### KB Document Index

```sql
CREATE TABLE kb_documents (
  space_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  path TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  tldr TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_slug TEXT,
  PRIMARY KEY (space_id, channel, path)
);
```

### Embedding Storage

For semantic search, embeddings are stored separately:

```sql
CREATE VIRTUAL TABLE kb_embeddings USING vec0(
  space_id TEXT NOT NULL,
  artifact_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  embedding float[1536]    -- OpenAI ada-002 dimension
);
```

### Auto-Indexing Rules

Artifacts are auto-indexed when:
1. Type is `doc`
2. Status is `published`
3. Has `knowledgebase` ancestor in tree hierarchy

**Code reference:** `packages/server/src/http.ts:2143-2170`

---

## Path Computation

The `path` field provides a hierarchical location for each artifact:

```typescript
function computeArtifactPath(spaceId, channelId, slug, parentSlug?): string {
  if (!parentSlug) {
    return `/${slug}`;
  }
  
  const parent = getArtifact(spaceId, channelId, parentSlug);
  if (!parent) {
    throw new Error(`Parent artifact not found: ${parentSlug}`);
  }
  
  return `${parent.path}/${slug}`;
}
```

**Implications:**
- Paths are computed on create, not updated when parent moves
- Moving an artifact (changing `parentSlug`) updates its path but NOT children's paths
- This is a known limitation — child paths may become stale

**Recommendation for v2:** Implement recursive path updates on parent move, or switch to materialized path pattern with triggers.

**Code reference:** `packages/storage/src/sqlite/index.ts:869-884`

---

## Glob Pattern Matching

The `globArtifacts` function supports file-system-like pattern matching:

| Pattern | Matches |
|---------|---------|
| `/**` | All artifacts |
| `/*` | Root-level only |
| `/planning/**` | All under /planning |
| `/**/*.ts` | All with .ts suffix |
| `/phase-*` | Root items starting with "phase-" |

**Implementation:** SQL LIKE queries with pattern translation:
- `*` → `%` (any chars)
- `**` → recursive descent (all descendants)

**Code reference:** `packages/storage/src/sqlite/index.ts:1155-1224`

---

## Reference Extraction

The `refs` field auto-extracts `[[slug]]` wiki-style links from content:

```
This spec references [[auth-api-spec]] and [[user-model]].
```

Produces: `refs: ["auth-api-spec", "user-model"]`

**Current Status:** Implemented in MCP layer, extracts on create/update.

---

## Root Channel Fallback

System artifacts (`system.*` types) support cross-channel lookup with `#root` fallback:

1. Look in current channel first
2. If not found, look in `#root` channel
3. This enables global MCP/agent definitions shared across channels

**Code reference:** `packages/mcp/src/registry.ts:29-49`

---

## Design Notes & Recommendations

### Current Limitations

1. **Path staleness** — Child paths don't update when parent moves
2. **No hard delete** — Archive is soft-delete only; no permanent removal API
3. **No bulk operations** — Each artifact must be created/updated individually
4. **Version diff** — Diff endpoint exists but limited to text comparison

### Recommendations for Clean Implementation

1. **Add recursive path updates** or use closure table for hierarchy
2. **Add hard delete** with cascade option for tree cleanup
3. **Add bulk create/update** for import scenarios
4. **Consider event sourcing** for richer version history
5. **Add `orderKey`** support for manual ordering within siblings (partially implemented)

