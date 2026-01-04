# Design Discoveries

Consolidated findings from the Cast collaboration tools design session. This document captures insights, gaps, and refinements discovered through exploration, prototyping, and scenario analysis.

## Session Overview

**Mission**: Design collaboration tools for Cast by studying and extending PowPow.

**Team**: coordinator, fox (scout), bear (scout)

**Outputs**:
- Design docs: `artifacts-system.md`, `decisions.md`, `future.md`
- Prototype: SQLite schema, store layer, MCP tools, REST endpoints
- Scenarios: 7 use case walkthroughs

---

## Core Design: Shared Artifacts System

Artifacts are the foundation for Cast collaboration. They provide persistent, structured, shareable work products that complement ephemeral chat.

### Key Insight: Artifacts as Universal Foundation

> "Tasks are artifacts with status. Pinned messages are artifacts referencing chat. Handoff summaries are artifacts. Build the artifact layer first and the other tools become specializations of it." — bear

This unifying insight shaped the design. Rather than building separate systems for tasks, pins, decisions, etc., we built one artifact system with type-based specialization.

### Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Type extensibility | Freeform string, blessed rendering | Flexibility without chaos |
| Visibility | Channel-scoped, cross-channel refs | Simple ownership model |
| Chat references | Client-side expansion | Current state, not snapshots |
| Real-time sync | Unified SSE stream | One connection, consistent state |
| Content updates | Match-replace (Edit tool pattern) | Race-condition safe, proven pattern |
| Tree navigation | parentId hierarchy | Enables Board view, task subtrees |

---

## Discoveries from Implementation

### Match-Replace Editing (simen's insight)

Original design: full content replacement only.

Discovery: The Edit tool pattern (match old_string → replace with new_string) is perfect for artifacts:
- Familiar to agents (same as file editing)
- Race-condition safe (old_string mismatch = conflict)
- Concurrent edits to different sections work naturally
- Minimal payload for small changes

**Added**: `edit_artifact` tool with single-match enforcement.

### Tree Navigation for Organization

Original design: flat list with optional parentId.

Discovery: Tree structure enables powerful organization:
- Tasks under specs
- Subtasks under tasks
- Comments/feedback under parent artifacts
- `parentId: "root"` sentinel for top-level queries

**Use case**: Board view can render navigable tree, not just flat list.

### Board View Concept

Evolution of firehose panel into unified activity viewer:
- Tree navigation of artifacts (expand/collapse)
- Real-time updates via SSE
- Search across artifacts
- Click `[artifact:name]` in chat → focuses artifact in Board
- Filter by type, status, assignee, labels

**Key insight**: Chat and Board are two views of the same channel state. Chat is the conversation, Board is the work products.

---

## Discoveries from Scenarios

### Scenarios Completed

| # | Scenario | Author | Focus |
|---|----------|--------|-------|
| 1 | Feature Development | fox | Spec → tasks → implementation |
| 2 | Bug Investigation | fox | Findings → decision → fix |
| 3 | Design Review | bear | Multi-reviewer feedback, approvals |
| 4 | Handoff | bear | Context transfer across sessions |
| 5 | Cross-Team Collab | coordinator | Cross-channel references |
| 6 | Docs Corpus | bear | 80+ artifact scale stress test |
| 7 | Language Design | fox | Evolving spec, breaking changes |

### Cross-Cutting Gaps (surfaced in multiple scenarios)

**Version History / Diffs** (scenarios 1, 2, 3, 6, 7)
- Spec evolution needs diffing
- Breaking changes need tracking
- "What changed since I last looked?" is common question
- Review workflows need before/after comparison

**Change Notifications** (scenarios 2, 3, 4, 5, 7)
- Agents don't know when artifacts they depend on change
- Cross-channel references have no update notification
- Reviewers need alerts when doc is revised
- Human "watch" feature for important artifacts

**Summary / Abbreviated Content** (scenarios 4, 6)
- Large artifacts overwhelm context windows
- Need TL;DR field for context injection
- Index views need compact representation

**Non-Hierarchical Relationships** (scenarios 1, 7)
- parentId gives tree structure
- Need "related to", "depends on", "implements" relationships
- Task A depends on Task B (not parent-child)

### Scale Concerns (scenarios 6, 7)

At 15 artifacts: manageable
At 80+ artifacts (docs corpus): needs work

**Pagination**: `list_artifacts` needs offset/limit for large sets
**Sorting**: Date-based queries (recently updated, oldest first)
**Grouping**: Label-based views, virtual folders
**Search**: Full-text search becomes critical at scale
**Bulk ops**: Moving/archiving multiple artifacts
**Reverse lookups**: "What artifacts reference this one?"

### Handoff & Context Management (scenario 4)

**Auto context injection**: New agents need artifact summary on join
**Handoff templates**: Standard structure for continuation notes
**Chat capture**: Current chat context not preserved in artifacts
**Read receipts**: No acknowledgment that handoff was received
**Selective injection**: Can't inject "just the important artifacts"

### Review Workflows (scenario 3)

**Approval status**: No formal approved/rejected/pending-review states
**Reviewer assignment**: No way to request review from specific agents
**Revision tracking**: Which version was reviewed?
**Comment resolution**: Feedback artifacts need resolved/unresolved status

### Cross-Channel Collaboration (scenario 5)

**Reference integrity**: If source artifact renamed/deleted, references break silently
**Notifications**: No auto-notify when referenced artifact in another channel changes
**Permissions**: Currently channel-level only; may need artifact-level for sensitive content

---

## Tools Implemented

### MCP Tools (for agents)

| Tool | Purpose |
|------|---------|
| `publish_artifact` | Create or full-replace artifact |
| `edit_artifact` | Match-replace content edit |
| `get_artifact` | Read single artifact |
| `list_artifacts` | Query with filters (type, status, parentId, assignee, search) |
| `update_task_status` | Convenience for task workflow |
| `archive_artifact` | Soft delete |

### REST Endpoints (for humans/UI)

```
GET    /api/channels/:ch/artifacts
GET    /api/channels/:ch/artifacts/:name
POST   /api/channels/:ch/artifacts
PUT    /api/channels/:ch/artifacts/:name
DELETE /api/channels/:ch/artifacts/:name
GET    /api/channels/:ch/artifacts/stream (SSE)
```

### SSE Events

```
event: messages    // chat updates (existing)
event: artifact    // { action: created|updated|deleted, artifact }
event: status      // agent status (future)
```

---

## Deferred Features (Prioritized by Scenario Evidence)

### High Priority (surfaced in 4+ scenarios)
- **Version history with diffs** - scenarios 1, 2, 3, 6, 7
- **Change notification system** - scenarios 2, 3, 4, 5, 7
- **Pagination for large artifact sets** - scenarios 6, 7
- **Summary field for context injection** - scenarios 4, 6

### Medium Priority (surfaced in 2-3 scenarios)
- **Non-hierarchical relationships** (depends-on, related-to) - scenarios 1, 7
- **Reverse reference lookup** ("what references this?") - scenarios 5, 6
- **Full-text search (FTS5)** - scenarios 6, 7
- **Approval workflow status** - scenario 3
- **Sorting/date queries** - scenario 6

### Lower Priority (surfaced in 1 scenario or nice-to-have)
- Artifact locking for critical docs
- Private drafts (visibility: private)
- Bulk operations (move, archive multiple)
- Cross-channel search
- Handoff templates
- Read receipts / acknowledgment
- Comment resolution status

### Out of Scope (different product)
- Real-time collaborative editing (CRDT/OT)
- File attachments / binary content

---

## Open Questions

1. Should artifact references use IDs or names for cross-channel links?
   - Names: human-readable, but break on rename
   - IDs: stable, but opaque

2. How do artifacts interact with agent context limits?
   - Large artifact trees could overwhelm context
   - Need selective injection strategy

3. Should there be artifact-level permissions?
   - Currently: channel access = artifact access
   - May need per-artifact visibility for sensitive content

4. What's the right UX for version history?
   - Full history vs. recent N versions
   - Diff rendering in Board view
   - Restore previous version workflow

---

## What We Learned About Collaboration

### Dogfooding Insights

Using PowPow to design its own extensions surfaced real friction:
- No way to pin/bookmark important messages (solved: artifacts)
- Can't reference back to earlier findings (solved: `[artifact:name]`)
- No visibility into teammate status (partial: status exists, could be richer)
- Parallel work needs coordination primitives (solved: tasks as artifacts)

### Agent-Human Collaboration Patterns

**Artifacts bridge the gap**:
- Agents produce artifacts as work products
- Humans review via Board view
- Chat is coordination, artifacts are output
- `[artifact:name]` links connect discussion to deliverables

**Edit tool pattern works for both**:
- Agents use `edit_artifact` MCP tool
- Humans use Board view editor (same underlying API)
- Conflict handling is consistent

---

## Next Steps (when resuming)

1. ~~Bear's remaining scenarios (3, 4, 6)~~ ✓ Complete
2. Update future.md with prioritized gaps from scenarios
3. Update artifacts-system.md with edit_artifact, Board view, search, summary field
4. Update decisions.md with new decisions (match-replace, tree nav, summary field)
5. Test prototype in separate session
6. Implement high-priority deferred features (version history, notifications)

---

## Session Stats

- **Duration**: ~1.5 hours
- **Commits**: 15+ to plan/collab branch
- **Design docs**: 5 files, ~1000 lines
- **Scenarios**: 7 walkthroughs, ~3500 lines
- **Prototype**: SQLite schema, 6 MCP tools, REST API, SSE sync
- **Gaps identified**: 20+ categorized by priority

---

*Document created by coordinator, consolidating input from fox, bear, and simen.*
