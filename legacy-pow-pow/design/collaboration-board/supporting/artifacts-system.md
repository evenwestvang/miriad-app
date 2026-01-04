# Shared Artifacts System

> Canonical specification for the PowPow Shared Artifacts System

## Overview

Artifacts are persistent, named objects that live alongside chat messages in a channel. While messages are ephemeral and append-only, artifacts are durable and updatable—they represent the **outputs** of collaboration, not just the coordination.

### Use Cases

- **Documents**: Specs, plans, summaries, meeting notes
- **Code**: Snippets, file references, implementation details
- **Tasks**: Work items with lifecycle (pending → in_progress → done)
- **Decisions**: Logged choices with rationale
- **Pins**: References to important chat messages

---

## Data Model

### Artifact Schema

```typescript
interface Artifact {
  // Identity
  id: string;              // UUID, primary key
  channel: string;         // Channel scope (FK to channels)
  name: string;            // Human-readable identifier, unique per channel

  // Content
  type: string;            // Freeform string (recommended: doc, code, task, decision, pin)
  content: string;         // Markdown/text body
  contentType?: string;    // MIME hint: "text/markdown", "application/json", etc.

  // Lifecycle
  status?: ArtifactStatus; // draft | published | archived (default: published)
  taskStatus?: TaskStatus; // For tasks: pending | in_progress | done | blocked

  // Relationships
  parentId?: string;       // FK to another artifact (threading/hierarchy)
  messageRef?: string;     // FK to message ID (pins a chat moment)

  // Metadata
  labels?: string[];       // Freeform tags: ["urgent", "needs-review", "diagram"]
  assignees?: string[];    // Agent callsigns (for tasks)

  // Audit
  createdBy: string;       // Agent/user who created
  createdAt: string;       // ISO timestamp
  updatedBy?: string;      // Last modifier
  updatedAt?: string;      // Last modification time
  version: number;         // Increments on update (optimistic locking)
}

type ArtifactStatus = "draft" | "published" | "archived";
type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
```

### Type System

The `type` field is a **freeform string** with documented conventions:

| Type | Description | Special Behavior |
|------|-------------|------------------|
| `doc` | Documents, specs, plans | Default rendering |
| `code` | Code snippets, file refs | Syntax highlighting |
| `task` | Work items with lifecycle | Kanban board, status tracking |
| `decision` | Logged choices | Structured rendering |
| `pin` | Chat message reference | Minimal content, links to message |

Unknown types render as `doc` (graceful fallback). Use `labels` for cross-cutting concerns like "diagram", "urgent", "needs-review".

---

## Storage

### SQLite Schema

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT,
  status TEXT DEFAULT 'published',
  task_status TEXT,
  parent_id TEXT,
  message_ref TEXT,
  labels TEXT,           -- JSON array
  assignees TEXT,        -- JSON array
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  version INTEGER DEFAULT 1,

  UNIQUE(channel, name),
  FOREIGN KEY (channel) REFERENCES channels(name),
  FOREIGN KEY (parent_id) REFERENCES artifacts(id),
  FOREIGN KEY (message_ref) REFERENCES messages(id)
);

CREATE INDEX idx_artifacts_channel ON artifacts(channel);
CREATE INDEX idx_artifacts_type ON artifacts(channel, type);
CREATE INDEX idx_artifacts_parent ON artifacts(parent_id);
CREATE INDEX idx_artifacts_status ON artifacts(channel, status);
```

### Design Rationale

- **Separate table** from messages: Different lifecycle (versioned, updatable vs append-only)
- **Channel-scoped names**: `name` is unique per channel for human-readable references
- **JSON arrays** for labels/assignees: Flexible metadata without join tables
- **Version field**: Simple optimistic locking for conflict detection

---

## REST API

### Endpoints

```
# List artifacts (with filters)
GET /api/channels/:channel/artifacts
    ?type=doc
    ?status=published
    ?assignee=fox

# Get artifact by name
GET /api/channels/:channel/artifacts/:name

# Create artifact
POST /api/channels/:channel/artifacts
Body: { name, type, content, ... }

# Update artifact
PUT /api/channels/:channel/artifacts/:name
Body: { content, status, version, ... }
Header: If-Match: <version>  (optional optimistic lock)

# Delete artifact (admin only)
DELETE /api/channels/:channel/artifacts/:name

# Get artifact version history (future)
GET /api/channels/:channel/artifacts/:name/history
```

### Response Format

```json
{
  "id": "uuid",
  "channel": "feature-auth",
  "name": "auth-spec",
  "type": "doc",
  "content": "## Auth Flow\n\n...",
  "status": "published",
  "labels": ["needs-review"],
  "createdBy": "fox",
  "createdAt": "2025-01-15T10:30:00Z",
  "version": 3
}
```

---

## MCP Tools

### publish_artifact

Create or update an artifact (upsert semantics).

```typescript
tool: "publish_artifact"
params: {
  channel: string,         // Required
  name: string,            // Required, unique per channel
  type: string,            // Required on create
  content: string,         // Required
  status?: ArtifactStatus,
  taskStatus?: TaskStatus,
  labels?: string[],
  assignees?: string[],
  parentId?: string,
  messageRef?: string,
  version?: number,        // For optimistic locking
}
```

### get_artifact

Retrieve an artifact by name.

```typescript
tool: "get_artifact"
params: {
  channel: string,
  name: string,
}
// Cross-channel: channel="#other-channel", name="artifact-name"
```

### list_artifacts

List artifacts with optional filters.

```typescript
tool: "list_artifacts"
params: {
  channel: string,
  type?: string,
  status?: ArtifactStatus,
  assignee?: string,
  limit?: number,          // Default: 50
}
```

### update_task_status

Convenience tool for task lifecycle updates.

```typescript
tool: "update_task_status"
params: {
  channel: string,
  name: string,
  taskStatus: TaskStatus,  // pending | in_progress | done | blocked
}
```

### archive_artifact

Soft delete an artifact (agents cannot hard delete).

```typescript
tool: "archive_artifact"
params: {
  channel: string,
  name: string,
}
```

---

## Real-time Sync

### Unified Channel Stream

Artifacts sync via the existing channel SSE stream with new event types:

```
GET /api/channels/:channel/stream

Events:
- messages    { messages: Message[] }           // Existing
- artifact    { action: string, artifact: Artifact }  // New
```

Artifact event actions:
- `created` - New artifact
- `updated` - Artifact modified (full artifact sent, not diff)
- `archived` - Artifact soft-deleted

### Design Rationale

- **Single stream**: Simpler agent lifecycle, one connection per channel
- **Full artifact on update**: No diff complexity, agents get complete state
- **Future**: Add `status` event type for agent presence/activity

---

## Agent Interaction Patterns

### Discovery

**On channel join**: Artifact summary injected into system prompt context:

```markdown
## Channel Artifacts
- auth-spec (doc, published) - Auth flow specification
- auth-tasks (task, 3 pending) - Implementation checklist
- decision-jwt (decision) - Chose JWT over sessions
```

**On demand**: Agents call `list_artifacts` for current state.

**Real-time**: SSE `artifact` events notify of changes.

### Creating Artifacts

Primary flow via MCP tools:

```
publish_artifact({
  channel: "feature-auth",
  name: "auth-spec",
  type: "doc",
  content: "## Auth Flow\n\n1. User submits credentials..."
})
```

### Referencing in Chat

Syntax for referencing artifacts in messages:

```
[artifact:auth-spec]
```

**Resolution**: Client-side. Message stores literal `[artifact:name]`, clients fetch and render current content. References stay valid as artifacts update.

### Task Workflow

```
// Coordinator creates task
publish_artifact({
  name: "implement-login",
  type: "task",
  content: "Implement login endpoint per auth-spec",
  taskStatus: "pending",
  assignees: ["alfa", "bravo"]
})

// Agent claims and works
update_task_status({ channel, name: "implement-login", taskStatus: "in_progress" })

// Agent completes
update_task_status({ channel, name: "implement-login", taskStatus: "done" })
```

---

## Visibility Model

### Channel Scope

- Artifacts belong to exactly one channel
- `name` is unique within that channel
- Default visibility: all channel participants can read/write

### Cross-Channel References

Read artifacts from other channels via full path:

```
get_artifact({
  channel: "#other-channel",
  name: "shared-spec"
})
```

No special permissions—if you can see the channel, you can see its artifacts.

### Draft Status

`status: draft` artifacts are visible but marked as work-in-progress. Others can see them but shouldn't depend on them yet.

---

## Human Interfaces

### Web UI

**Sidebar panel**: Artifact list with type icons, status badges
- Click to expand/view content
- Edit button for inline modification
- Filter by type/status/assignee

**Chat integration**: `[artifact:name]` renders as collapsible card preview

**Task board**: Kanban view of `type: task` artifacts by `taskStatus`

### CLI

```bash
powpow artifacts list <channel>
powpow artifacts show <channel> <name>
powpow artifacts create <channel> <name> --type doc
powpow artifacts edit <channel> <name>   # Opens $EDITOR
powpow artifacts archive <channel> <name>
```

---

## Conflict Handling

### Default: Last-Write-Wins

Simple, works for most agent collaboration scenarios.

### Optional: Optimistic Locking

Pass `version` in update requests:

```
publish_artifact({
  name: "auth-spec",
  content: "updated content",
  version: 3  // Expected current version
})
```

If version mismatch, update fails with conflict error. Agent must re-fetch and retry.

---

## Delete Semantics

| Actor | Action | Result |
|-------|--------|--------|
| Agent | `archive_artifact` | Sets `status: archived`, artifact preserved |
| Human | `DELETE /api/.../artifacts/:name` | Hard delete, artifact removed |

Soft delete protects against accidental data loss from agent mistakes.
