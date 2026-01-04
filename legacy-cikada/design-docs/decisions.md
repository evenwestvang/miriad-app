# Architectural Decisions Log

This document records significant architectural decisions made during Cikada development, including context, options considered, and rationale.

---

## ADR-001: SDK Sandbox Agent Architecture

**Date:** 2025-12-31
**Status:** Decided (Fargate chosen)

### Context

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is designed to spawn the Claude Code CLI as a subprocess. It's not a standalone library - it's a wrapper around `cli.js` that communicates via IPC.

This doesn't fit Lambda's execution model:
- CLI is 100MB+ with dependencies
- Needs persistent filesystem for `.claude/` state
- Lambda `/tmp` is ephemeral
- Cold starts would be 10-30+ seconds

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| Bundle CLI into Lambda | Simple deployment | Huge cold starts, no persistence |
| ECS/Fargate | Persistent FS, matches SDK | Higher cost (~$0.05/hour) |
| Raw Anthropic API | Lambda-native, full control | Loses SDK orchestration |
| Lambda Container Image | Docker packaging | Still no persistence |

### Decision

**ECS/Fargate for sandbox agents.** Local development uses Docker containers with the same architecture.

- Best fit for Claude Code CLI requirements
- Persistent workspace via EFS (AWS) or volume mounts (local)
- Idle timeout (5-10 min) manages costs
- Session resume via `--continue` flag

---

## ADR-002: MVP Scope

**Date:** 2025-12-30
**Status:** Completed

### Context

Needed to validate core architecture before building full platform.

### Decision

MVP includes:
- Channels (messages only, no board/artifacts initially)
- Durable agents (local SQLite, not Lambda Durable yet)
- Basic frontend (React, Tymbal streaming)
- Fake auth (dropdown picker, no real auth)

MVP excludes:
- Board/artifact system (added later)
- Stateless agents
- Sandbox agents (added later)
- Real authentication
- Multi-org/project

### Outcome

MVP completed December 30, 2025. Full stack verified E2E with tool execution.

---

## ADR-003: Durable Agent Primitives

**Date:** 2025-12-30
**Status:** Completed

### Context

Need checkpointed execution for long-running agent tasks.

### Decision

Implement local durable context with Lambda Durable-compatible API:

```typescript
// Checkpointed operation - replays cached result on recovery
await ctx.step("fetch-data", async () => fetchData());

// Suspend at zero cost until callback
await ctx.waitForCallback("wait-for-user");

// Fan-out with per-branch checkpointing
await ctx.parallel("tasks", [() => taskA(), () => taskB()]);

// Batch processing with concurrency control
await ctx.map("items", items, (item) => process(item), { maxConcurrency: 10 });
```

SQLite persistence with step-level granularity. 30 tests passing.

---

## ADR-004: Storage Abstraction

**Date:** 2025-12-30
**Status:** Implemented

### Context

Need to support local development (SQLite) and production (DynamoDB).

### Decision

- `packages/storage/` provides abstract storage interface
- SQLite adapter for local/self-hosted
- DynamoDB adapter for AWS
- Same API, swap at configuration time

### Implementation

```typescript
// Local
const storage = createSqliteStorage({ path: './cikada.db' });

// AWS (future)
const storage = createDynamoStorage({ tableName: 'cikada-prod' });
```

---

## ADR-005: Artifact Board System

**Date:** 2025-12-31
**Status:** Implemented

### Context

Need persistent work products beyond ephemeral messages.

### Decision

Port PowPow's artifact model:
- Types: `doc`, `task`, `decision`, `code`
- Tree hierarchy via `parentSlug`
- Status tracking (draft, published, pending, done, etc.)
- FTS5 full-text search
- CAS (compare-and-swap) for concurrent updates
- Soft delete (archive) only

### Key Design Choices

| Choice | Decision | Rationale |
|--------|----------|-----------|
| Archive vs Delete | Archive only | Safer, reversible |
| Slug validation | `^[a-z0-9-]+(\.[a-z0-9]+)*$` | Supports file names |
| Parent mutable | Yes | Allow tree reorganization |
| Content limit | 1MB | Larger files use binary assets |

---

## ADR-006: MCP Tools for Board Access

**Date:** 2025-12-31
**Status:** Implemented

### Context

Agents in containers need to interact with the board.

### Decision

Built-in MCP server in container wrapper, auto-configured at spawn:

```
Orchestrator → spawn(channelId, callsign) → Container
                                              ├── CIKADA_API_URL
                                              ├── CIKADA_CHANNEL_ID
                                              └── CIKADA_CALLSIGN
                                              └── MCP Server (auto-configured)
```

Tools wrap HTTP API: `artifact_create`, `artifact_read`, `artifact_list`, `artifact_glob`, `artifact_update`, `artifact_edit`, `artifact_archive`.

---

## ADR-007: Tymbal Protocol for Streaming

**Date:** 2025-12-30
**Status:** Implemented

### Context

Need real-time message streaming to frontend.

### Decision

Use Tymbal protocol (from Tymbal repo):

```json
// Start streaming
{"i": "msgId", "m": {"type": "assistant", "sender": "fox"}}

// Append content
{"i": "msgId", "a": "streaming text..."}

// Finalize
{"i": "msgId", "t": "...", "v": {"type": "assistant", "content": "..."}}
```

WebSocket transport, NDJSON framing.

---

## ADR-008: Tool Call Streaming Format

**Date:** 2026-01-01
**Status:** Implemented

### Context

Claude Code CLI embeds tool_use in assistant messages, not as separate events.

### Decision

TymbalBridge extracts tool blocks from message content:
- `tool_use` blocks from assistant messages → `tool_call` frames
- `tool_result` blocks from user messages → `tool_result` frames

Frontend handles both wrapped and direct frame formats.

---

## ADR-009: Container Non-Root User

**Date:** 2026-01-01
**Status:** Implemented

### Context

Claude Code's `--dangerously-skip-permissions` flag cannot be used as root.

### Decision

Dockerfile creates non-root `claude` user:

```dockerfile
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app /workspace
USER claude
```

---

## Template for New Decisions

```markdown
## ADR-XXX: [Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Decided | Implemented | Superseded

### Context

[What is the issue we're addressing?]

### Options Considered

[List options with pros/cons]

### Decision

[What did we decide and why?]

### Consequences

[What are the implications?]
```
