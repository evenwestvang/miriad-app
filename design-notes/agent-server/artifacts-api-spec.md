# Artifacts API Specification

## Overview

Artifacts are exposed through two interfaces:
1. **HTTP REST API** — For web clients and external integrations
2. **MCP Tools** — For AI agents via Model Context Protocol

Both interfaces share the same underlying storage and broadcast mechanisms.

---

## HTTP REST API

Base path: `/channels/:channelId/artifacts`

All endpoints require space authentication (handled via session/token).

### Create Artifact

```
POST /channels/:channelId/artifacts
```

**Request Body:**
```json
{
  "slug": "auth-api-spec",
  "type": "doc",
  "tldr": "API specification for authentication endpoints",
  "content": "# Auth API\n\n...",
  "title": "Auth API Spec",
  "parentSlug": "planning",
  "status": "published",
  "assignees": ["alfa"],
  "labels": ["api", "auth"],
  "props": {},
  "createdBy": "alfa"
}
```

**Required fields:** `slug`, `type`, `tldr`, `content`, `createdBy`

**Response:** `201 Created` with full artifact object

**Validation:**
- `slug` must be unique within channel
- `system.*` types validate `props` against schema
- `parentSlug` must exist if provided

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:90-126`

---

### Read Artifact

```
GET /channels/:channelId/artifacts/:slug
```

**Response:** `200 OK` with full artifact including `versions` array

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:142-159`

---

### List Artifacts

```
GET /channels/:channelId/artifacts
```

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `type` | string | Filter by artifact type |
| `status` | string | Filter by status |
| `assignee` | string | Filter tasks by assignee callsign |
| `parentSlug` | string | Filter by parent (`root` for top-level only) |
| `search` | string | Keyword search across slug, title, tldr, content |
| `regex` | string | Regex pattern search |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |

**Response:** `200 OK` with `{ artifacts: ArtifactSummary[] }`

`ArtifactSummary` includes: `slug`, `path`, `type`, `title`, `status`, `tldr`, `assignees`

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:175-189`

---

### Glob Tree View

```
GET /channels/:channelId/artifacts/tree?pattern=/**
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `pattern` | string | `/**` | Glob pattern for matching |

**Pattern Examples:**
- `/**` — Entire tree
- `/auth-system/**` — Subtree under auth-system
- `/**/*.ts` — All TypeScript files
- `/*` — Root level only

**Response:** `200 OK` with `{ tree: string }` — formatted text tree

**Tree Format:**
```
/planning
  /phase-1 :task (done)
    setup-repo :task (done) @fox
    setup-ci :task (done) @bear
  /phase-2 :task (in_progress)
```

Format rules:
- Directories (artifacts with children) prefixed with `/`
- Type suffix `:type` shown unless `doc`
- Status in parens unless `published`
- Assignees as `@callsign`

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:205-219`

---

### Update Artifact (Simple)

```
PATCH /channels/:channelId/artifacts/:slug
```

**Request Body (simple update):**
```json
{
  "title": "Updated Title",
  "tldr": "Updated summary",
  "content": "Updated content",
  "status": "done",
  "parentSlug": "new-parent",
  "assignees": ["alfa", "bravo"],
  "labels": ["updated"],
  "updatedBy": "alfa"
}
```

All fields optional except `updatedBy`.

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:237-263`

---

### Update Artifact (Compare-and-Swap)

```
PATCH /channels/:channelId/artifacts/:slug
```

**Request Body (CAS update):**
```json
{
  "changes": [
    { "field": "status", "oldValue": "pending", "newValue": "in_progress" },
    { "field": "assignees", "oldValue": [], "newValue": ["alfa"] }
  ],
  "updatedBy": "alfa"
}
```

**CAS Semantics:**
- All changes are atomic — all succeed or all fail
- If any `oldValue` doesn't match current value, returns `409 Conflict`
- Used for safe concurrent updates (e.g., task claiming)

**Conflict Response:**
```json
{
  "error": "CAS conflict",
  "conflict": {
    "field": "status",
    "expected": "pending",
    "actual": "in_progress"
  }
}
```

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:281-319`

---

### Archive Artifact

```
DELETE /channels/:channelId/artifacts/:slug
```

**Query Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `updatedBy` | string | Yes | Archiver callsign |

**Response:** `200 OK` with `{ archived: true, artifact: Artifact }`

This is a **soft delete** — sets status to `archived`. Artifact can still be queried with `status=archived` filter.

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:336-356`

---

### Checkpoint (Version Snapshot)

```
POST /channels/:channelId/artifacts/:slug/checkpoint
```

**Request Body:**
```json
{
  "version": "v1.0",
  "message": "Initial release",
  "createdBy": "alfa"
}
```

**Response:** `201 Created` with `ArtifactVersion`

Creates an immutable snapshot of current `tldr` and `content`.

**Code reference:** `packages/storage/src/sqlite/index.ts:1224-1254`

---

### Get Artifact Version

```
GET /channels/:channelId/artifacts/:slug/versions/:versionName
```

**Response:** `200 OK` with version snapshot content

---

### List Artifact Versions

```
GET /channels/:channelId/artifacts/:slug/versions
```

**Response:** `200 OK` with `{ versions: ArtifactVersion[] }`

---

## MCP Tool Interface

Exposed via HTTP transport at `/mcp/:channelId/tools/*`

### Tool List

```
POST /mcp/:channelId/tools/list
```

Returns available tools for the channel context.

### Tool Call

```
POST /mcp/:channelId/tools/call
```

**Request:**
```json
{
  "name": "artifact_create",
  "arguments": { ... }
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `artifact_create` | Create new artifact |
| `artifact_read` | Read single artifact |
| `artifact_list` | Query with filters |
| `artifact_glob` | Tree view via glob pattern |
| `artifact_update` | CAS atomic update |
| `artifact_edit` | Surgical find-replace on content |
| `artifact_archive` | Soft delete |
| `message_get` | Get recent channel messages |
| `message_search` | Search messages by keyword/sender |

### artifact_edit

Unique to MCP — performs surgical string replacement:

```json
{
  "name": "artifact_edit",
  "arguments": {
    "slug": "auth-spec",
    "old_string": "function login(",
    "new_string": "async function login(",
    "updatedBy": "alfa"
  }
}
```

**Behavior:**
- Fails if `old_string` not found
- Fails if `old_string` matches multiple times (ambiguous)
- Uses CAS internally to prevent race conditions

**Code reference:** `packages/server/src/mcp-http.ts:517-573`

---

## WebSocket Broadcasts

All mutations broadcast Tymbal frames to channel subscribers:

```json
{
  "i": "artifact:auth-spec",
  "t": "2026-01-04T12:00:00.000Z",
  "v": {
    "type": "artifact",
    "action": "created",
    "artifact": { ... }
  }
}
```

Actions: `created`, `updated`, `archived`

**Code reference:** `packages/handlers/src/artifacts/handlers.ts:32-42`

---

## Props Schema API

### Get Schema for Type

```
GET /artifacts/schema/:type
```

Returns JSON Schema for `system.mcp`, `system.agent`, `system.focus` props.

### List Types with Schemas

```
GET /artifacts/schema
```

Returns `{ types: ["system.mcp", "system.agent", "system.focus"] }`

**Code reference:** `packages/server/src/artifact-schemas.ts:222-229`

