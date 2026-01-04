# Artifact Tools Improvement Plan

Based on feedback from #cast-codex (6 agents) and workshop discussion.

---

## Immediate Fixes

### 1. Default `assignees` to `[]` instead of `null`
**Problem:** First CAS update on a new artifact fails because agents expect `[]` but get `null`.

**Solution:** Schema default change + migration for existing artifacts.

**Impact:** High — hits every coordinator on first task claim (5 mentions in feedback).

---

### 2. Allow multiple dots for chained extensions
**Problem:** Currently only one dot allowed, but file naming conventions use chained extensions (`auth.test.ts`, `config.prod.json`).

**Solution:** Update slug validation to allow multiple dots when they form valid extension chains. Pattern: `slug-name.ext1.ext2` is valid, but `..` (path traversal) and leading/trailing dots remain blocked.

**Examples:**
- ✅ `auth.test.ts`
- ✅ `config.prod.json`
- ✅ `banana.test.py`
- ❌ `../escape`
- ❌ `.hidden`
- ❌ `trailing.`

**Impact:** Medium — code change to validation regex, improves DX for code artifacts.

---

### 3. Document re-parenting in tool notes
**Problem:** No agents realized `update` supports `parentSlug` for moving artifacts in the tree.

**Solution:** Add explicit note to `update` tool description:
> "To move an artifact in the tree, update `parentSlug` with the new parent's slug (or `null` for root)."

**Impact:** Low effort, prevents confusion.

---

### 4. Clarify code artifact format in tool description
**Problem:** Agents wrap code in markdown fences (```) when creating code artifacts, but artifacts should contain raw code only.

**Solution:** Update `create` tool description for code type:
> "For code artifacts, content should be raw code without markdown fences. The slug's file extension (e.g., `auth-middleware.ts`) provides syntax highlighting."

**Impact:** Low effort — prevents formatting issues in code artifacts.

---

## Medium-Term Additions

### 5. Bulk status update via existing `update` tool
**Problem:** Updating N tasks requires N separate calls. Coordinators marking phase completion need many round-trips.

**Solution:** Add optional `slugs` array parameter to existing `update` tool. When provided, applies same changes to all slugs.

**Proposed API:**
```
update({
  channel: "my-channel",
  slugs: ["task-1", "task-2", "task-3"],  // new optional param
  changes: [
    { field: "status", old_value: "in_progress", new_value: "done" }
  ],
  sender: "coordinator"
})
```

When `slugs` array is provided, `slug` (singular) is ignored. 

**Semantics:**
- All-or-nothing — if any slug fails (CAS conflict, not found), entire operation fails
- Error explains which slug failed and why
- No partial updates — either all succeed or none do

**Impact:** High for coordinators — frequent pain point. No new tool needed.

---

### 6. Regex search in `list`
**Problem:** Current keyword search is basic. No pattern matching for larger boards.

**Proposed API:**
```
artifact_list({
  channel: "my-channel",
  pattern: "auth.*spec",  // regex pattern
  searchFields: ["content", "title", "tldr"]  // optional, defaults to all
})
```

**Output:** Same as current `list` — slug, type, title, status, tldr, assignees.

**Notes:**
- Full regex supported
- Execution timeout as safeguard against pathological patterns

**Impact:** Medium — useful as boards grow.

---

## Parked (Needs Design)

- **Task dependency tracking** — requires cycle detection, status propagation
- **Git integration** — external system, separate concern
- **Reverse reference lookup** — needs refs indexing infrastructure

---

## Summary

| Item | Effort | Impact | Status |
|------|--------|--------|--------|
| `assignees: []` default | Low | High | Ready |
| Allow chained extensions in slugs | Low-Medium | Medium | Ready |
| Document re-parenting | Low | Low | Ready |
| Clarify code artifact format | Low | Medium | Ready |
| Bulk status update | Medium | High | Needs API review |
| Regex search | Low-Medium | Medium | Needs API review |
