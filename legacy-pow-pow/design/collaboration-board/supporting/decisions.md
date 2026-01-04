# Artifact System Design Decisions

This document captures the design decisions made during the Cast collaboration tools design session. Each decision includes the context, options considered, and rationale for the choice.

---

## 1. Type Extensibility

**Decision**: Freeform string with blessed types for special UI treatment.

**Context**: Should artifact `type` be a fixed enum or a freeform string?

**Options considered**:
- **Enum**: Fixed set (`doc`, `code`, `task`, `decision`, `pin`). Types drive UI behavior.
- **Freeform**: Any string allowed. Let usage drive standardization.
- **Hybrid**: Freeform storage, but document "blessed" types with special rendering.

**Choice**: Hybrid approach.

**Rationale**:
- Freeform string in schema allows experimentation without migrations
- Blessed types (`doc`, `code`, `task`, `decision`, `pin`) get special UI treatment
- Unknown types fall back to generic doc rendering - safe default
- Labels handle cross-cutting concerns ("urgent", "needs-review") orthogonal to type
- Types control *behavior*, labels control *metadata*

---

## 2. Visibility Scope

**Decision**: Channel-scoped by default with cross-channel read via path syntax.

**Context**: How are artifacts scoped? Can they be shared across channels?

**Options considered**:
- **Channel-only**: Artifacts belong to exactly one channel, no cross-references
- **Global**: Artifacts exist outside channels, linked into channels
- **Channel-scoped with refs**: Belong to one channel, readable from others via path

**Choice**: Channel-scoped with cross-channel references.

**Rationale**:
- Artifacts belong to exactly one channel (simple ownership model)
- Cross-channel reference via full path: `#other-channel/artifact-name`
- No special permissions - if you can see the channel, you can see its artifacts
- Avoids complexity of global namespace and permission matrix
- Future extension: `visibility: private` field if agent-local drafts are needed

---

## 3. Artifact References in Chat

**Decision**: Client-side expansion, not server-side.

**Context**: When a message contains `[artifact:name]`, should the server expand it inline or leave it for clients to resolve?

**Options considered**:
- **Server-side**: Message stored with expanded content. Always consistent, works offline. But creates large messages and stale content if artifact updates.
- **Client-side**: Message stores reference, client fetches and renders. Always current, small messages. Requires extra fetch.

**Choice**: Client-side rendering.

**Rationale**:
- Message stores literal `[artifact:name]` - immutable reference
- Client/agent fetches artifact content when rendering
- Artifact can update after message was sent - reference stays valid
- No content duplication in messages table
- If artifact is deleted, show "missing artifact" indicator
- The reference is a pointer, not a snapshot - current state matters

---

## 4. SSE Event Payload

**Decision**: Full artifact on update events, no diff.

**Context**: When an artifact changes, should SSE events include just the diff or the complete artifact?

**Options considered**:
- **Diff**: Send only changed fields. Smaller payload, but clients must maintain state and apply patches.
- **Full**: Send complete artifact every time. Larger payload, but simpler client logic.

**Choice**: Full artifact.

**Rationale**:
- Simpler implementation - no diff computation or patch application
- Agents get complete state each time, no cache synchronization needed
- Artifacts are typically small (text content) - payload size is manageable
- If diffs become necessary for large artifacts, that's a future optimization

---

## 5. Delete Semantics

**Decision**: Soft delete (archive) for agents, hard delete for humans only.

**Context**: Should agents be able to permanently delete artifacts?

**Options considered**:
- **Hard delete**: Agents can permanently remove artifacts via MCP tool
- **Soft delete only**: Agents can archive, humans hard delete via REST API
- **No delete**: Artifacts are permanent, only status changes

**Choice**: Soft delete for agents, hard delete for humans.

**Rationale**:
- Agents call `archive_artifact` - sets `status: archived`, artifact still exists
- Hard delete via REST API only (`DELETE /api/channels/:channel/artifacts/:name`)
- Protects against accidental data loss from agent mistakes
- Admin/human can hard delete if truly needed
- Similar to git: agents can create and archive, deleting history is a human decision

---

## 6. Storage Model

**Decision**: Separate SQLite table, not extending messages.

**Context**: Should artifacts be stored in the existing messages table or a new table?

**Options considered**:
- **Extend messages**: Add artifact fields to messages table. Single table, simpler queries.
- **Separate table**: New `artifacts` table with its own schema. Clear separation of concerns.

**Choice**: Separate table.

**Rationale**:
- Different lifecycles: messages are append-only/immutable, artifacts are versioned/updatable
- Different access patterns: messages are time-ordered, artifacts are name-keyed
- Cleaner schema without nullable fields for artifact-specific data
- Foreign key from artifacts to messages (for `messageRef`) maintains relationship
- Indexes can be optimized for each table's query patterns

---

## 7. Real-time Sync Architecture

**Decision**: Unified channel stream with multiple event types.

**Context**: Should artifact updates go through the existing channel SSE stream or a separate stream?

**Options considered**:
- **Separate stream**: `/api/channels/:channel/artifacts/stream` for artifact-only events
- **Unified stream**: Extend existing `/api/channels/:channel/stream` with new event types

**Choice**: Unified stream.

**Rationale**:
- Single connection per channel - simpler agent lifecycle management
- Multiple event types on one stream:
  ```
  event: messages    // existing chat messages
  event: artifact    // { action: "created"|"updated"|"deleted", artifact }
  event: status      // future: agent presence/activity
  ```
- Agents always need both chat context and artifact state - no case for artifacts-only
- Reduces connection overhead and keeps wrapper implementation simple

---

## 8. Artifact Discovery

**Decision**: Inject artifact summary into system prompt on channel join.

**Context**: How do agents discover what artifacts exist in a channel?

**Options considered**:
- **On-demand only**: Agents must call `list_artifacts` to discover
- **Prompt injection**: Summary injected into system prompt like roster
- **Both**: Injection for awareness, tools for details

**Choice**: Both - injection plus tools.

**Rationale**:
- Artifact summary injected on join (mirrors how roster works):
  ```
  ## Channel Artifacts
  - auth-spec (doc, published) - Auth flow specification
  - auth-tasks (task, 3 pending) - Implementation checklist
  ```
- `list_artifacts` tool for filtered queries and current state
- SSE events for real-time updates after join
- Agents are aware of artifacts immediately, can fetch details as needed

---

## Summary

| Decision | Choice | Key Rationale |
|----------|--------|---------------|
| Type extensibility | Freeform + blessed types | Flexibility without chaos |
| Visibility scope | Channel-scoped + cross-refs | Simple ownership, readable across |
| Chat references | Client-side expansion | Current state, not snapshots |
| SSE payload | Full artifact | Simplicity over optimization |
| Delete semantics | Soft for agents | Safety net for mistakes |
| Storage | Separate table | Different lifecycles |
| Sync architecture | Unified stream | One connection, multiple events |
| Discovery | Injection + tools | Immediate awareness |
