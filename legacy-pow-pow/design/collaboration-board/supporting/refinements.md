# Design Refinements

Refinements to the Artifact System design based on review discussion with simen. These updates supersede earlier decisions in `decisions.md` where they conflict.

---

## Schema Changes

### Slug as Primary Identifier

**Previous**: UUID as `id`, `name` as human-readable identifier
**New**:
- `id` (UUID) - internal DB primary key only, never exposed
- `slug` - immutable human-readable identifier, used in all tools and refs
- `title` - optional mutable display name

```typescript
interface Artifact {
  id: string;        // UUID, internal only
  slug: string;      // "auth-api-spec", immutable, public identifier
  title?: string;    // "Authentication API Spec", mutable display
  tldr: string;      // Required summary (see below)
  content: string;   // Markdown content
  // ... other fields
}
```

**Slug rules:**
- Set on create, never changes
- Unique per channel
- Format: `[a-z0-9-]+` (lowercase, hyphens, no spaces)
- Cross-channel reference: `[[#channel/slug]]`

**Rationale**: Slugs provide stable references that are also human-readable. Browsing a tree of slugs gives you context without fetching content.

---

### Required `tldr` Field

**New field**: Every artifact must have a `tldr` (summary) field.

**Used for:**
- Context injection (inject TLDRs instead of full content)
- List views and Board preview cards
- Search result snippets
- Quick orientation before reading full content

**Constraints:**
- Required on create
- Should be kept brief (1-3 sentences)
- Updated when content changes significantly

---

### Auto-Populated `refs` Field

**New field**: `refs: string[]` - automatically populated on save.

When artifact is saved, content is parsed for `[[slug]]` and `[[#channel/slug]]` links. Referenced slugs are stored in `refs[]`.

**Enables:**
- Reverse lookup: "What artifacts reference this one?"
- Impact analysis before rename/archive
- Dependency graphs

---

## Tool Changes

### Separate Create and Update

**Previous**: `publish_artifact` was upsert (create or update)
**New**: Explicit separation

| Tool | Purpose | Behavior |
|------|---------|----------|
| `publish_artifact` | Create only | Error if slug exists |
| `edit_artifact` | Surgical update | Match-replace, error if doesn't exist |
| `replace_artifact` | Full replacement | Replace all content, error if doesn't exist |
| `archive_artifact` | Soft delete | Set status to archived |

**Rationale**: Explicit intent prevents accidental overwrites. If you want to replace an artifact, you must be explicit about it.

### Full Tool Set

```typescript
// Create new artifact
publish_artifact({
  channel: string,
  slug: string,           // immutable identifier
  title?: string,         // optional display name
  tldr: string,           // required summary
  type: string,           // "doc", "task", "decision", etc.
  content: string,        // markdown
  parentSlug?: string,    // for tree structure
  labels?: string[],
  assignees?: string[],
})

// Surgical edit (match-replace)
edit_artifact({
  channel: string,
  slug: string,
  old_string: string,
  new_string: string,
})

// Full content replacement
replace_artifact({
  channel: string,
  slug: string,
  content: string,
  tldr?: string,          // can update tldr too
  title?: string,         // can update title too
  message?: string,       // optional checkpoint message
})

// Read artifact
get_artifact({
  channel: string,
  slug: string,
})

// Query artifacts
list_artifacts({
  channel: string,
  type?: string,
  status?: string,
  parentSlug?: string,    // "root" for top-level only
  assignee?: string,
  search?: string,        // keyword search
  limit?: number,
  offset?: number,
})

// Soft delete
archive_artifact({
  channel: string,
  slug: string,
})
```

---

## Versioning: Named Checkpoints

### Two Modes of Editing

**Silent edits**: Normal editing via `edit_artifact` or `replace_artifact`
- Internal version number increments (for optimistic locking)
- No history entry created
- No notifications triggered

**Checkpoints**: Explicitly declare a named version
- Creates a snapshot stored in history
- Triggers notifications to @mentioned users
- Becomes diff-able against other checkpoints

### Checkpoint API

```typescript
checkpoint_artifact({
  channel: string,
  slug: string,
  version: string,        // "v1.0", "draft-2", "final"
  message?: string,       // "Addressed security feedback"
})
```

### Checkpoint Behavior

1. Snapshot current content stored in `artifact_checkpoints` table
2. Parse content for @mentions
3. Auto-post notification to channel:
   ```
   [checkpoint] auth-api-spec v2.0: "Addressed security feedback"
   cc: @fox @bear
   ```
4. Emit `artifact_checkpoint` SSE event (distinct from `artifact_updated`)

### Checkpoint Immutability

Checkpoints are append-only. Even if artifact is archived, checkpoints remain for audit trail. "What was the spec when we shipped v1?" is always answerable.

---

## Link Semantics

### Reference Syntax

In artifact content (markdown):
- Same channel: `[[slug]]`
- Cross channel: `[[#channel/slug]]`

### Resolution

- Links parsed on save, slugs stored in `refs[]`
- Client/Board renders links as clickable
- Broken links shown gracefully ("artifact not found")
- Not fatal—this is a collaboration board, not a formal system

---

## Notifications

### @mentions in Artifacts

When a checkpoint is created:
1. Parse content for `@callsign` patterns
2. Post notification message to channel with @mentions
3. Recipients see it via normal chat mechanism

**No new notification system needed**—reuses existing chat @mention delivery.

---

## SSE Events

```
event: messages           // chat updates (existing)
event: artifact           // { action: created|updated|deleted, artifact }
event: artifact_checkpoint // { slug, version, message, mentions[] }
event: status             // agent status (future)
```

`artifact_checkpoint` distinct from `artifact_updated` lets watchers distinguish "just an edit" from "author says this is ready for review."

---

## Summary of Changes

| Aspect | Previous | New |
|--------|----------|-----|
| Primary identifier | UUID (`id`) | Slug (immutable, human-readable) |
| Display name | `name` (used for refs) | `title` (mutable, optional) |
| Summary | Optional | Required `tldr` field |
| References | Stored in content only | Auto-extracted to `refs[]` |
| Create behavior | Upsert | Create-only, error if exists |
| Full replacement | Part of publish | Separate `replace_artifact` tool |
| Version history | Store every edit | Named checkpoints only |
| Notifications | Not specified | @mentions parsed on checkpoint |

---

*Documented by coordinator based on discussion with simen, fox, and bear.*
