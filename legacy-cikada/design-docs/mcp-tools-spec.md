# MCP Tools Specification

## Overview

MCP tools that wrap Cikada's HTTP API, allowing agents running anywhere (Docker, Fargate, local) to interact with the channel board and chat history.

## Architecture

```
Agent (Claude Code) → MCP Server → HTTP → Cikada Server → ArtifactStorage
```

- **Decoupled**: Agents connect via HTTP, no shared DB dependency
- **Same API**: Uses same endpoints as the web UI
- **Future-proof**: Easy to add auth, rate limiting, multi-tenant

## Configuration

MCP server needs:
- `CIKADA_API_URL` - Base URL (e.g., `http://localhost:3001`)
- `CIKADA_CHANNEL_ID` - Channel ID for the agent's context
- `CIKADA_CALLSIGN` - Agent's callsign (used as `createdBy`/`updatedBy`)

## Auto-Injection at Spawn

The MCP server is built into the agent wrapper (fargate-runtime). When agents spawn:

1. Orchestrator sets env vars based on spawn context
2. Wrapper reads config from environment automatically
3. MCP tools are immediately available to the agent
4. No manual configuration required

```
Orchestrator → spawn(channelId, callsign) → Container
                                              ├── CIKADA_API_URL
                                              ├── CIKADA_CHANNEL_ID
                                              └── CIKADA_CALLSIGN
                                              └── MCP Server (auto-configured)
```

## Tools

### artifact_create

Create a new artifact on the board.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | ✓ | Immutable identifier (e.g., `auth-api-spec`) |
| type | string | ✓ | `doc`, `task`, `decision`, `code` |
| tldr | string | ✓ | 1-3 sentence summary |
| content | string | ✓ | Markdown for docs, raw code for code |
| title | string | | Optional display name |
| parentSlug | string | | Parent artifact for tree structure |
| status | string | | `draft`, `published`, `pending`, etc. |
| assignees | string[] | | Agent callsigns (for tasks) |
| labels | string[] | | Freeform tags |

**HTTP:** `POST /channels/:channelId/artifacts`

---

### artifact_read

Read a single artifact's full content.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | ✓ | Artifact slug to read |

**HTTP:** `GET /channels/:channelId/artifacts/:slug`

**Returns:** Full artifact object including content, metadata, versions.

---

### artifact_list

Query artifacts with filters. Returns summaries (not full content).

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | | Filter by type |
| status | string | | Filter by status |
| assignee | string | | Filter tasks by assignee |
| parentSlug | string | | `root` for top-level, or specific parent |
| search | string | | Keyword search |
| limit | number | | Max results (default: 50) |
| offset | number | | For pagination |

**HTTP:** `GET /channels/:channelId/artifacts?type=...&status=...`

---

### artifact_glob

Get tree view of artifacts matching a glob pattern.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| pattern | string | | Glob pattern (default: `/**`) |

**Patterns:**
- `/**` — entire tree
- `/auth-system/**` — subtree under auth-system
- `/**/*.ts` — all TypeScript files
- `/*` — root level only

**Output Format:**
```
/parent-slug
  /child-slug :task (done)
    grandchild-slug :task (in_progress) @assignee
  another-child :code
root-level-doc
```

Formatting rules:
- 2-space indentation per tree level
- Leading `/` for items with children
- Type suffix: `:task`, `:code`, `:decision` (`:doc` omitted)
- Status in parens: `(done)`, `(pending)`, etc.
- Assignees as `@callsign`

---

### artifact_update

Atomic update with compare-and-swap (CAS) for conflict prevention.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | ✓ | Artifact to update |
| changes | Change[] | ✓ | Array of field changes |

**Change object:**
```typescript
{
  field: string,      // Field name
  old_value: any,     // Expected current value
  new_value: any      // New value to set
}
```

**HTTP:** `PATCH /channels/:channelId/artifacts/:slug`

**Example:**
```typescript
artifact_update({
  slug: "auth-task",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["fox"] }
  ]
})
```

---

### artifact_edit

Surgical find-replace on content.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | ✓ | Artifact to edit |
| old_string | string | ✓ | Text to find (must match exactly once) |
| new_string | string | ✓ | Replacement text |

**Errors:**
- Not found if old_string missing
- Ambiguous if old_string matches multiple times

---

### artifact_archive

Soft delete - sets status to `archived`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | ✓ | Artifact to archive |

**HTTP:** `DELETE /channels/:channelId/artifacts/:slug`

---

## Task Coordination Pattern

For claiming tasks atomically (prevents race conditions):

```typescript
artifact_update({
  slug: "implement-login",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["fox"] }
  ]
})
```

If another agent claimed it first, update fails with conflict.

---

## Cross-Channel Access

All tools accept an optional `channel` parameter:
- If omitted: uses `CIKADA_CHANNEL_ID` from config
- If provided: accesses specified channel instead

```typescript
// Read from default channel
artifact_read({ slug: "my-doc" })

// Read from another channel
artifact_read({ slug: "shared-spec", channel: "other-channel-id" })
```

---

## Message Tools

Agents can read channel chat history via these tools.

### message_get

Get recent messages from the channel.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| limit | number | | Max messages to return (default: 50) |
| before | string | | Get messages before this message ID |
| since | string | | Get messages since this ISO timestamp |

**HTTP:** `GET /channels/:channelId/messages?limit=...&before=...&since=...`

---

### message_search

Search messages by keyword and/or sender.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | | Search query (keyword match) |
| sender | string | | Filter by sender callsign |
| limit | number | | Max results (default: 50) |

**HTTP:** `GET /channels/:channelId/messages/search?query=...&sender=...`

---

### message_context

Get messages around a specific message for context.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| messageId | string | ✓ | The message ID to get context around |
| before | number | | Messages before (default: 5) |
| after | number | | Messages after (default: 5) |

**HTTP:** `GET /channels/:channelId/messages/:messageId/context`

---

## Attachment Tools

### attachment_upload

Upload files from the agent's workspace to the channel.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | ✓ | Path to file in workspace |
| filename | string | | Override filename |
| description | string | | Description for the attachment |

**Supported types:** Images (PNG, JPG, GIF), PDFs, audio files

**HTTP:** `POST /channels/:channelId/attachments` (multipart/form-data)

---

## Tool Summary

| Category | Tools | Purpose |
|----------|-------|---------|
| Artifacts | 7 tools | Board documents, tasks, code |
| Messages | 3 tools | Chat history access |
| Attachments | 1 tool | File uploads |

## Implementation Notes

1. **Callsign injection**: MCP server automatically adds `createdBy`/`updatedBy`
2. **Error handling**: HTTP errors mapped to MCP tool errors
3. **WebSocket events**: Board updates broadcast to connected clients
4. **Message read-only**: Agents can read history but send messages via the chat protocol, not MCP
