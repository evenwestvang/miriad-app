# Artifact Tools Feedback

Compiled from #cast-codex team during Codex integration sprint (6 agents).

---

## What Works Well

### Structure & Navigation
- **Tree structure** (`/phase-1/task-1-1-*`) gives clear visual hierarchy (@coordinator, @alfa, @charlie)
- **`glob`** with tree view is great for seeing structure at a glance (@fox, @ruby, @steward)
- **`artifact_list`** with type/status filters makes tracking easy (@coordinator)
- **`parentSlug`** helps organize work logically (@ruby, @alfa)
- Tree structure scales better than flat lists (@fox)

### CRUD Operations
- **`create`/`read`/`edit`** cycle is intuitive - clean CRUD pattern (@fox, @charlie)
- **Compare-and-swap** on `update` prevents race conditions when claiming tasks (@coordinator, @alfa, @charlie)
- **Cross-referencing** via `[[slug]]` in content is useful (@fox)
- **`read` with full content** is great for code review (@ruby)
- **`checkpoint`** for version snapshots useful for review points (@alfa)

### Process
- Direct commits to feature branch + artifact reviews worked smoothly (@steward)
- Task status tracking makes it easy to see what's done/pending (@ruby)
- Tools didn't get in the way of the work (@charlie)

---

## Friction Points

### Slug Validation
- **No dots allowed** in slugs - had to rename `mcp-compat.test.ts` to `mcp-compat-test` (@fox)
- Want to use file extensions for code artifacts but validation blocks it (@fox)

### Initial State Inconsistencies
- **`assignees` field starts as `null` vs `[]`** causing CAS mismatches (@coordinator, @fox)
- First update requires knowing whether field is null or empty array

### Compare-and-Swap Noise
- CAS conflicts frequent during fast-moving coordination (@coordinator)
- Not a bug - correct behavior - but noisy for coordinators
- Team members often updated status before coordinator could

### Missing Bulk Operations
- **No bulk update** - updating multiple task statuses requires separate calls (@coordinator, @alfa, @charlie)
- Marking all Phase 1 tasks done requires N individual updates
- Creating task hierarchies requires N sequential calls (@charlie)

### Versioning & Diffs
- `checkpoint` + `diff` workflow exists but wasn't heavily used this sprint (@fox)
- No way to view diffs between versions without explicit `diff` call (@ruby)
- Unclear if `checkpoint` actually notifies anyone (@charlie)

### Search & Discovery
- `artifact_list` search is basic keyword matching (@alfa, @charlie)
- No regex or structured queries for larger boards
- No "what references this artifact?" reverse lookup (@alfa)

### Review Workflow
- When builders post code artifacts, reviewer had to explicitly request them (@ruby)
- No batch read for multiple slugs in one call (@ruby)

### Git Integration
- Manual reporting of branch state - no auto-tracking of commits/PRs (@steward)
- No cross-linking between artifacts and git commits (@steward)

---

## Suggestions

### High Priority
1. **Bulk status update** - mark multiple tasks done at once (@coordinator, @alfa, @charlie)
2. **`artifact_move`** - reorganize tree structure without recreate (@fox)
3. **Fix `assignees` initial state** - default to `[]` not `null` (@coordinator, @fox)
4. **Batch operations** - create/read multiple artifacts in one call (@charlie, @ruby)

### Medium Priority
5. **Task dependency tracking** - built-in, not just noted in content (@coordinator)
6. **Syntax highlighting hint** - `read` should return language from slug/contentType (@fox)
7. **Allow dots in slugs** - or add separate `language` field for code artifacts (@fox)
8. **Search improvements** - date range, regex, "modified by me" filters (@alfa, @charlie)
9. **Reverse reference lookup** - "what references this artifact?" (@alfa)
10. **Git integration** - branch status artifact type, commit↔artifact linking (@steward)

### Nice to Have
11. **Watch/subscription model** for artifact changes (like messages have) (@fox)
12. **Optional CAS bypass** for coordinator role on status updates (@coordinator)
13. **Artifact templates** - predefined structures for common patterns (@alfa)
14. **Auto-post convention** - when builders complete code, auto-notify reviewers (@ruby)

---

## Contributors
- @fox (Scout) - slug validation, bulk ops, versioning, syntax hints
- @coordinator (Coordinator) - CAS conflicts, bulk ops, dependency tracking
- @alfa (Builder) - bulk ops, search, templates, cross-references
- @charlie (Builder) - batch create, search, checkpoint notifications
- @ruby (Reviewer) - batch read, diff visibility, review workflow
- @steward (Branch Manager) - git integration, commit tracking
