# Future Enhancements

Deferred ideas and features for the Artifacts System. These were discussed during design but intentionally left out of v1 to keep scope manageable.

## Deferred Features

### Message Threading
- Allow messages to reply to other messages
- Build conversation threads within channels
- Potentially use same `parentId` pattern as artifacts

**Why deferred**: Adds complexity to message model and UI. Current flat model works for small teams. Revisit when channels get noisy.

### Private Drafts
- Add `visibility: private | channel` field to artifacts
- Private artifacts visible only to creator until published
- Enables work-in-progress without cluttering shared view

**Why deferred**: Adds permission complexity. Current `status: draft` is visible but marked as WIP—usually sufficient. Real need hasn't been demonstrated yet.

### Version History UI
- Store artifact versions in separate table
- UI to browse history, diff versions, restore old versions
- `version` field already exists for optimistic locking

**Why deferred**: Storage and UI complexity. Current "last write wins" is fine for agent collaboration where context is fresh. History matters more for long-lived documents.

### Artifact Templates
- Predefined structures for common artifact types
- Task templates with standard fields
- Decision templates with options/rationale sections

**Why deferred**: Let usage patterns emerge first. Templates can be added once we see what structures repeat.

### Cross-Channel Artifact Search
- Global search across all channel artifacts
- Full-text search on content
- Filter by type, status, labels

**Why deferred**: Requires search index infrastructure. Channel-scoped `list_artifacts` is sufficient for now.

### Real-Time Collaborative Editing
- Multiple agents editing same artifact simultaneously
- Operational transform or CRDT-based sync
- Cursor presence, live updates

**Why deferred**: Major infrastructure investment. Current model (last-write-wins with version conflicts) handles sequential edits. True real-time collab is a different product.

### Agent Status Dashboard
- Live view of which agents are running
- Current status/activity per agent
- Channel presence indicators

**Why deferred**: Useful but orthogonal to artifacts. Can be built as separate feature on existing status system.

## Implementation Notes (from spike)

These details emerged during prototype implementation and need to be addressed in production:

### Sender Identity in MCP Tools
Currently, agents pass their own callsign as a `sender` param to tools that need it. This is redundant—the agent already knows who it is.

**Future improvement**: Inject sender identity from MCP session context, eliminating the explicit parameter.

### Cross-Channel Reference Syntax
Spec says `#other-channel/artifact-name` but MCP tools use separate params. Implementation accepts `channel: "#other-channel"` with the # prefix stripped internally.

**Document**: The # prefix convention for cross-channel references in tool params.

### "root" Sentinel for parentId
To query top-level artifacts only, use `parentId: "root"` which maps to `parent_id IS NULL`.

**Document**: This magic string convention in the API reference.

### Version Conflict Error Format
When optimistic locking fails (version mismatch), the system returns HTTP 409 with error message "Version conflict - artifact was modified".

**Document**: Error response format for conflict scenarios.

## Open Questions

- Should artifacts support file attachments (images, binaries)?
- How do artifacts interact with agent memory/context limits?
- Should there be artifact-level permissions beyond channel membership?

## Related Ideas (Not Artifacts)

These emerged during design discussion but aren't part of the artifacts system:

- **Message pinning**: Could be `type: pin` artifact pointing to message
- **Task board**: Could be UI view over `type: task` artifacts
- **Handoff summaries**: Could be `type: summary` artifact generated on context overflow

The artifacts system is designed to be a foundation these can build on.
