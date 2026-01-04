# Client API Reference

Complete API reference for Cikada frontend clients. Covers HTTP endpoints, WebSocket streaming, request/response formats, and error handling.

**Base URL**: Configurable (default: `http://localhost:3001`)

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Channels](#2-channels)
3. [Roster Management](#3-roster-management)
4. [Agent Management](#4-agent-management)
5. [Messages](#5-messages)
6. [Structured Asks](#6-structured-asks)
7. [Artifacts](#7-artifacts)
8. [Assets & Attachments](#8-assets--attachments)
9. [Knowledge Base](#9-knowledge-base)
10. [WebSocket Streaming](#10-websocket-streaming)
11. [Error Handling](#11-error-handling)

---

## 1. Authentication

Authentication is session-based using cookies. Two modes are supported:

### 1.1 Mock Auth (Development)

For local development without real OAuth.

#### GET /mock-auth/login

Display login page with existing accounts.

**Response**: HTML login page

#### GET /mock-auth/callback

Handle login, create session.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | string | Existing user ID to login as |
| `new_user` | string | Create new user with this ID |

**Response**: Redirect with `Set-Cookie: session=...`

#### POST /mock-auth/logout

Clear session.

**Response**: `200 OK` with `Set-Cookie` clearing session

---

### 1.2 WorkOS OAuth (Production)

Real OAuth flow with WorkOS.

**Note**: The reference implementation uses Sanity OAuth, but the reimplementation will use **WorkOS** for production authentication.

#### GET /auth/workos/login

Start OAuth flow.

**Response**: Redirect to WorkOS OAuth

#### GET /auth/workos/callback

Handle OAuth callback.

**Response**: Redirect with session cookie

#### POST /auth/workos/logout

Clear session.

**Response**: `200 OK`

---

## 2. Channels

### GET /channels

List all channels in the user's space.

**Response**: `200 OK`
```json
{
  "channels": [
    {
      "id": "01HXYZ...",
      "name": "my-channel",
      "status": "active",
      "tagline": "Project workspace",
      "mission": "Build the thing",
      "leader": "lead",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /channels

Create a new channel.

**Request Body**:
```json
{
  "name": "my-channel",
  "description": "Optional description",
  "focusSlug": "open",
  "tagline": "Override tagline",
  "mission": "Override mission"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Channel name |
| `description` | string | No | Channel description |
| `focusSlug` | string | No | Focus area template (e.g., "open") |
| `tagline` | string | No | Short label (overrides focus default) |
| `mission` | string | No | Purpose description (overrides focus default) |

**Response**: `201 Created`
```json
{
  "channel": {
    "id": "01HXYZ...",
    "name": "my-channel",
    "status": "active",
    "tagline": "Override tagline",
    "mission": "Override mission",
    "leader": "lead",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### GET /channels/:id

Get channel details with roster.

**Response**: `200 OK`
```json
{
  "channel": {
    "id": "01HXYZ...",
    "name": "my-channel",
    "status": "active",
    "tagline": "...",
    "mission": "...",
    "leader": "lead"
  },
  "roster": [
    {
      "id": "lead",
      "name": "lead",
      "type": "agent",
      "status": "online",
      "joinedAt": "2024-01-01T00:00:00.000Z",
      "agentConfig": {
        "agentName": "lead",
        "engine": "reactive",
        "model": "claude-sonnet-4-20250514"
      }
    }
  ]
}
```

---

### DELETE /channels/:id

Archive a channel (soft delete).

**Response**: `200 OK`
```json
{ "success": true }
```

---

## 3. Roster Management

### POST /channels/:id/roster

Add participant to roster.

**Request Body**:
```json
{
  "participantId": "user-123",
  "name": "Alice",
  "participantType": "user",
  "agentConfig": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `participantId` | string | Yes | Unique participant ID |
| `name` | string | Yes | Display name |
| `participantType` | string | Yes | `"user"` or `"agent"` |
| `agentConfig` | object | No | Agent configuration (for agents) |

**Response**: `201 Created`
```json
{
  "entry": {
    "id": "user-123",
    "name": "Alice",
    "type": "user",
    "status": "online",
    "joinedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### DELETE /channels/:id/roster/:participantId

Remove participant from roster.

**Response**: `200 OK`
```json
{ "success": true }
```

---

## 4. Agent Management

### GET /agents

List available agent types.

**Response**: `200 OK`
```json
{
  "agentTypes": [
    { "id": "claude-code", "name": "Claude Code", "description": "Coding assistant with file access" },
    { "id": "claude-sonnet", "name": "Claude Sonnet", "description": "General purpose assistant" },
    { "id": "claude-opus", "name": "Claude Opus", "description": "Advanced reasoning assistant" }
  ]
}
```

---

### GET /focus-types

List available focus area templates.

**Response**: `200 OK`
```json
{
  "focusTypes": [
    {
      "slug": "open",
      "title": "Open",
      "tldr": "Open-ended focus for freeform work"
    }
  ]
}
```

---

### POST /channels/:id/agents

Add agent to channel.

**Request Body**:
```json
{
  "agentType": "engineer",
  "callsign": "fox"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentType` | string | Yes | Agent definition slug |
| `callsign` | string | Yes | Unique callsign for this agent |

**Response**: `201 Created`
```json
{
  "success": true,
  "agent": {
    "id": "fox",
    "callsign": "fox",
    "agentType": "engineer",
    "status": "idle"
  }
}
```

**Errors**:
- `400` - Callsign already exists
- `404` - Agent type not found

---

### DELETE /channels/:id/agents/:callsign

Dismiss agent from channel.

**Response**: `200 OK`
```json
{ "success": true }
```

**Errors**:
- `400` - Cannot dismiss channel leader
- `404` - Agent not found

---

## 5. Messages

### POST /channels/:id/messages

Send a message to the channel.

**Request Body**:
```json
{
  "content": "Hello @lead, can you help?",
  "sender": "alice",
  "senderType": "user"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Message content (supports @mentions) |
| `sender` | string | Yes | Sender identifier |
| `senderType` | string | Yes | `"user"` or `"agent"` |

**@mention Routing**:
- `@callsign` - Routes to specific agent
- `@channel` - Broadcasts to all agents
- No mention - Routes to channel leader

**Response**: `201 Created`
```json
{
  "id": "01HXYZ...",
  "channelId": "...",
  "sender": "alice",
  "content": "Hello @lead, can you help?",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### GET /channels/:id/messages

Get messages for a channel.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `since` | string | Return messages after this ID (ULID) |
| `before` | string | Return messages before this ID (ULID) |
| `limit` | number | Max messages to return (default: 50) |

**Response**: `200 OK`
```json
{
  "messages": [
    {
      "id": "01HXYZ...",
      "channelId": "...",
      "sender": "alice",
      "senderType": "user",
      "type": "user",
      "content": "Hello!",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "isComplete": true
    }
  ]
}
```

---

## 6. Structured Asks

Interactive forms that agents can present to users.

### POST /channels/:id/structured-asks

Create a structured ask (typically called by agents).

**Request Body**:
```json
{
  "sender": "lead",
  "prompt": "Which approach should we take?",
  "formData": {
    "fields": [
      {
        "id": "choice",
        "type": "radio",
        "label": "Select approach",
        "options": [
          { "value": "a", "label": "Option A" },
          { "value": "b", "label": "Option B" }
        ]
      }
    ]
  }
}
```

**Response**: `201 Created`
```json
{
  "id": "01HXYZ...",
  "type": "structured_ask",
  "content": { /* form data */ }
}
```

---

### POST /channels/:id/structured-asks/:messageId/submit

Submit response to a structured ask.

**Request Body**:
```json
{
  "response": {
    "choice": "a"
  },
  "respondedBy": "alice"
}
```

**Response**: `200 OK`
```json
{
  "message": { /* updated message with response */ }
}
```

---

## 7. Artifacts

Artifacts are persistent work products stored on the channel's board. They form a tree hierarchy and support versioning.

### 7.1 Artifact Types

| Type | Description | Default Status |
|------|-------------|----------------|
| `doc` | Specs, plans, notes, documentation | `published` |
| `task` | Work items with status tracking | `pending` |
| `code` | Code snippets (syntax highlighted by extension) | `published` |
| `decision` | Logged choices with rationale | `published` |
| `system.mcp` | MCP server configuration | `published` |
| `system.agent` | Agent definition | `published` |
| `system.focus` | Channel template | `published` |
| `system.playbook` | Workflow guidelines | `published` |

### 7.2 Artifact Statuses

**Document-oriented**: `draft`, `published`, `archived`

**Task-oriented**: `pending`, `in_progress`, `done`, `blocked`

---

### POST /channels/:id/artifacts

Create a new artifact.

**Request Body**:
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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | Yes | Immutable identifier (e.g., `auth-api-spec`) |
| `type` | string | Yes | Artifact type |
| `tldr` | string | Yes | 1-3 sentence summary |
| `content` | string | Yes | Markdown for docs, raw code for code artifacts |
| `title` | string | No | Display name |
| `parentSlug` | string | No | Parent artifact for tree hierarchy |
| `status` | string | No | Initial status (defaults by type) |
| `assignees` | string[] | No | Agent callsigns (for tasks) |
| `labels` | string[] | No | Freeform tags |
| `props` | object | No | Type-specific properties (validated for `system.*` types) |
| `createdBy` | string | Yes | Creator callsign |

**Response**: `201 Created`
```json
{
  "id": "01HXYZ...",
  "slug": "auth-api-spec",
  "channelId": "...",
  "type": "doc",
  "title": "Auth API Spec",
  "tldr": "API specification for authentication endpoints",
  "content": "# Auth API\n\n...",
  "path": "/planning/auth-api-spec",
  "status": "published",
  "parentSlug": "planning",
  "assignees": ["alfa"],
  "labels": ["api", "auth"],
  "refs": [],
  "props": {},
  "version": 1,
  "createdBy": "alfa",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Errors**:
- `400` - Missing required fields or invalid props schema
- `400` - Slug already exists
- `404` - Parent artifact not found

---

### GET /channels/:id/artifacts

List artifacts with optional filters. Returns summaries (not full content).

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by artifact type |
| `status` | string | Filter by status |
| `assignee` | string | Filter tasks by assignee callsign |
| `parentSlug` | string | Filter by parent (`root` for top-level only) |
| `search` | string | Keyword search (slug, title, tldr, content) |
| `regex` | string | Regex pattern search |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |

**Response**: `200 OK`
```json
{
  "artifacts": [
    {
      "slug": "auth-api-spec",
      "path": "/planning/auth-api-spec",
      "type": "doc",
      "title": "Auth API Spec",
      "status": "published",
      "tldr": "API specification for authentication endpoints",
      "assignees": []
    }
  ]
}
```

---

### GET /channels/:id/artifacts/tree

Get artifact tree view via glob pattern.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | string | `/**` | Glob pattern for matching |

**Pattern Examples**:
- `/**` — Entire tree
- `/planning/**` — Subtree under planning
- `/**/*.ts` — All TypeScript files
- `/*` — Root level only

**Response**: `200 OK`
```json
{
  "tree": "/planning\n  /phase-1 :task (done)\n    setup-repo :task (done) @fox\n  auth-api-spec"
}
```

**Tree Format**:
- Directories (artifacts with children) prefixed with `/`
- Type suffix `:type` shown unless `doc`
- Status in parens unless `published`
- Assignees as `@callsign`

---

### GET /channels/:id/artifacts/:slug

Read a single artifact's full content.

**Response**: `200 OK`
```json
{
  "id": "01HXYZ...",
  "slug": "auth-api-spec",
  "channelId": "...",
  "type": "doc",
  "title": "Auth API Spec",
  "tldr": "...",
  "content": "# Auth API\n\n...",
  "path": "/planning/auth-api-spec",
  "status": "published",
  "parentSlug": "planning",
  "assignees": [],
  "labels": [],
  "refs": [],
  "props": {},
  "version": 3,
  "createdBy": "alfa",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": "bravo",
  "updatedAt": "2024-01-02T00:00:00.000Z",
  "versions": [
    { "version": "v1.0", "createdAt": "...", "createdBy": "alfa" }
  ]
}
```

**Errors**:
- `404` - Artifact not found

---

### PATCH /channels/:id/artifacts/:slug

Update an artifact. Supports two modes: simple update or CAS (compare-and-swap).

#### Simple Update

Direct field updates without conflict checking.

**Request Body**:
```json
{
  "updatedBy": "bravo",
  "title": "New Title",
  "tldr": "Updated summary",
  "content": "Updated content",
  "status": "done",
  "parentSlug": "new-parent",
  "assignees": ["alfa", "bravo"],
  "labels": ["updated"]
}
```

All fields optional except `updatedBy`.

**Response**: `200 OK` with updated artifact

#### CAS (Compare-and-Swap) Update

Atomic updates with conflict detection. All changes succeed or all fail.

**Request Body**:
```json
{
  "updatedBy": "bravo",
  "changes": [
    { "field": "status", "oldValue": "pending", "newValue": "in_progress" },
    { "field": "assignees", "oldValue": [], "newValue": ["bravo"] }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `changes` | array | Yes | Array of field changes |
| `changes[].field` | string | Yes | Field name to update |
| `changes[].oldValue` | any | Yes | Expected current value |
| `changes[].newValue` | any | Yes | New value to set |
| `updatedBy` | string | Yes | Updater callsign |

**Allowed Fields**: `title`, `tldr`, `content`, `status`, `parentSlug`, `assignees`, `labels`, `props`

**Response**: `200 OK` with updated artifact

**Conflict Response**: `409 Conflict`
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

---

### DELETE /channels/:id/artifacts/:slug

Archive an artifact (soft delete). Sets status to `archived`.

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `updatedBy` | string | Yes | Archiver callsign |

**Response**: `200 OK`
```json
{
  "archived": true,
  "artifact": { /* archived artifact */ }
}
```

---

### POST /channels/:id/artifacts/:slug/checkpoint

Create a named version snapshot.

**Request Body**:
```json
{
  "version": "v1.0",
  "message": "Initial release",
  "createdBy": "alfa"
}
```

**Response**: `201 Created`
```json
{
  "slug": "auth-api-spec",
  "versionName": "v1.0",
  "versionMessage": "Initial release",
  "versionCreatedAt": "2024-01-01T00:00:00.000Z",
  "versionCreatedBy": "alfa",
  "tldr": "...",
  "content": "..."
}
```

---

### GET /channels/:id/artifacts/:slug/versions

List all version snapshots.

**Response**: `200 OK`
```json
{
  "versions": [
    {
      "versionName": "v1.0",
      "versionMessage": "Initial release",
      "versionCreatedAt": "...",
      "versionCreatedBy": "alfa"
    }
  ]
}
```

---

### GET /channels/:id/artifacts/:slug/versions/:versionName

Read a specific version snapshot.

**Response**: `200 OK`
```json
{
  "slug": "auth-api-spec",
  "versionName": "v1.0",
  "versionMessage": "Initial release",
  "versionCreatedAt": "...",
  "versionCreatedBy": "alfa",
  "tldr": "...",
  "content": "..."
}
```

---

### 7.3 WebSocket Artifact Events

Artifact mutations broadcast Tymbal frames:

```json
{
  "i": "artifact:auth-api-spec",
  "t": "2024-01-01T00:00:00.000Z",
  "v": {
    "type": "artifact",
    "action": "created",
    "artifact": { /* full artifact */ }
  }
}
```

**Actions**: `created`, `updated`, `archived`

---

## 8. Assets & Attachments

### POST /channels/:id/assets

Upload binary asset (multipart/form-data).

### GET /channels/:id/assets/:slug

Serve asset file.

### POST /channels/:id/attachments

Upload attachment (multipart/form-data).

### GET /channels/:id/attachments/:attachmentId

Serve attachment file.

### PATCH /channels/:id/attachments/:attachmentId

Link attachment to message.

---

## 9. Knowledge Base

### GET /api/kbs

List all published knowledge bases.

**Response**: `200 OK`
```json
{
  "knowledgeBases": [
    {
      "channel": "docs",
      "title": "Documentation",
      "tldr": "Project documentation"
    }
  ]
}
```

### GET /api/kbs/:channel

Get KB metadata.

### GET /api/kbs/:channel/tree

Get KB document tree.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Glob pattern (default: `/**`) |

### GET /api/kbs/:channel/search

Search KB content.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query |
| `mode` | string | `keyword` or `semantic` |
| `limit` | number | Max results |

### GET /api/kbs/:channel/docs/*

Read KB document by path.

---

## 10. WebSocket Streaming

Real-time message streaming using Tymbal protocol.

### Connection

**Endpoint**: `ws://host/channels/:channelId/stream`

**Authentication**: Requires valid session cookie.

**Example**:
```javascript
const ws = new WebSocket('ws://localhost:3001/channels/01HXYZ/stream');
```

### Sync Request

Request historical messages after connection.

**Client → Server**:
```json
{"request": "sync", "since": "01HXYZ..."}
```

**Server Response**: Stream of SetFrames for messages since the given ID.

### Frame Types

Messages are sent as NDJSON (newline-delimited JSON).

#### MetaFrame (Start streaming)
```json
{"i": "msgId", "m": {"type": "assistant", "sender": "lead"}}
```

#### AppendFrame (Incremental content)
```json
{"i": "msgId", "a": "streaming text..."}
```

#### SetFrame (Complete message)
```json
{
  "i": "msgId",
  "t": "2024-01-01T00:00:00.000Z",
  "v": {
    "type": "assistant",
    "sender": "lead",
    "senderType": "agent",
    "content": "Complete message content"
  }
}
```

### Message Types in Frames

| Type | Description |
|------|-------------|
| `user` | Human message |
| `assistant` | Agent response |
| `tool_call` | Agent tool invocation |
| `tool_result` | Tool execution result |
| `thinking` | Agent thinking/reasoning |
| `status` | Status update |
| `error` | Error message |
| `agent_message` | Agent-to-agent message |
| `structured_ask` | Interactive form |
| `attachment` | File attachment |

### Roster Events

Broadcast when roster changes:

```json
{
  "i": "agent:fox",
  "t": "2024-01-01T00:00:00.000Z",
  "v": {
    "type": "roster",
    "action": "agent_joined",
    "agent": {
      "callsign": "fox",
      "agentType": "engineer",
      "status": "idle"
    }
  }
}
```

Actions: `agent_joined`, `agent_dismissed`

---

## 11. Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request (validation error) |
| `401` | Unauthorized (no/invalid session) |
| `403` | Forbidden (access denied) |
| `404` | Not Found |
| `409` | Conflict (CAS failure) |
| `500` | Internal Server Error |

### Error Response Format

```json
{
  "error": "Human-readable error message"
}
```

### CAS Conflict Response

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

### WebSocket Error Codes

| Code | Meaning |
|------|---------|
| `4000` | Invalid path |
| `4001` | Unauthorized |
| `4003` | Forbidden (channel not in space) |

---

## Appendix: Common Patterns

### Pagination

Use `since`/`before` with ULIDs for cursor-based pagination:
```
GET /channels/:id/messages?before=01HXYZ&limit=50
```

### Real-time + REST Sync

1. Connect WebSocket to `/channels/:id/stream`
2. Send sync request: `{"request": "sync", "since": "lastKnownMsgId"}`
3. Receive historical messages as SetFrames
4. Continue receiving real-time frames

### @mention Routing

Messages are routed based on @mentions:
- `@alice` → Routes to agent "alice"
- `@channel` → Broadcasts to all agents  
- No mention from user → Routes to channel leader

