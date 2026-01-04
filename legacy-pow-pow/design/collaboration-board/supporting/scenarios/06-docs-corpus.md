# Scenario 6: Documentation Corpus

> Managing a large documentation corpus with many interrelated artifacts

## Cast

- **coordinator** - Doc lead, manages structure and quality
- **alfa** - Technical writer, creates and updates docs
- **bravo** - Developer, contributes API docs from code
- **charlie** - QA, verifies docs match implementation
- **Human** - Product owner, approves major changes

## Channel: #docs-platform-v3

---

## Context

The team is migrating documentation to artifacts. The corpus includes:
- 50+ concept docs
- 30+ API reference pages
- 20+ tutorials
- 15+ troubleshooting guides
- Cross-references between docs
- Multiple versions (v2, v3)

This scenario stress-tests scale, organization, and navigation.

---

## Phase 1: Initial Structure

**Coordinator** creates organizational structure using parent artifacts:

```
publish_artifact({
  channel: "docs-platform-v3",
  name: "docs-root",
  type: "doc",
  content: `# Platform v3 Documentation

This is the root of the v3 documentation tree.

## Sections
- [artifact:section-concepts] - Core concepts
- [artifact:section-api] - API reference
- [artifact:section-tutorials] - Step-by-step guides
- [artifact:section-troubleshooting] - Problem solving

## Version
Platform: v3.0.0
Docs: 2025-01-15`,
  status: "published",
  labels: ["root", "v3"]
})

publish_artifact({
  channel: "docs-platform-v3",
  name: "section-concepts",
  type: "doc",
  content: "# Core Concepts\n\nFoundational documentation for understanding the platform.",
  parentId: "<docs-root-id>",
  labels: ["section"]
})

publish_artifact({
  channel: "docs-platform-v3",
  name: "section-api",
  type: "doc",
  content: "# API Reference\n\nComplete API documentation.",
  parentId: "<docs-root-id>",
  labels: ["section"]
})

publish_artifact({
  channel: "docs-platform-v3",
  name: "section-tutorials",
  type: "doc",
  content: "# Tutorials\n\nStep-by-step guides for common tasks.",
  parentId: "<docs-root-id>",
  labels: ["section"]
})

publish_artifact({
  channel: "docs-platform-v3",
  name: "section-troubleshooting",
  type: "doc",
  content: "# Troubleshooting\n\nSolutions to common problems.",
  parentId: "<docs-root-id>",
  labels: ["section"]
})
```

**Board view** (tree):
```
▼ docs-root (doc, published) [root, v3]
  ├─ section-concepts (doc) [section]
  ├─ section-api (doc) [section]
  ├─ section-tutorials (doc) [section]
  └─ section-troubleshooting (doc) [section]
```

---

## Phase 2: Populating Content (Scale Test)

**Alfa** creates concept docs:

```
// Authentication concept
publish_artifact({
  channel: "docs-platform-v3",
  name: "concept-auth",
  type: "doc",
  content: `# Authentication

## Overview
Platform v3 uses JWT-based authentication...

## Key Concepts
- Access tokens (15 min TTL)
- Refresh tokens (7 day TTL)
- Token rotation

## Related
- [artifact:concept-authorization] - Permissions
- [artifact:api-auth-login] - Login endpoint
- [artifact:tutorial-auth-setup] - Getting started`,
  parentId: "<section-concepts-id>",
  labels: ["concept", "auth"]
})

// Authorization concept
publish_artifact({
  channel: "docs-platform-v3",
  name: "concept-authorization",
  type: "doc",
  content: `# Authorization

## Overview
Role-based access control (RBAC)...

## Roles
- admin, editor, viewer

## Related
- [artifact:concept-auth] - Authentication
- [artifact:api-permissions] - Permissions API`,
  parentId: "<section-concepts-id>",
  labels: ["concept", "auth"]
})

// ... 15 more concept docs
```

**Bravo** generates API docs from code:

```
// Auth endpoints
publish_artifact({
  channel: "docs-platform-v3",
  name: "api-auth-login",
  type: "doc",
  content: `# POST /api/auth/login

Authenticate a user and receive tokens.

## Request
\`\`\`json
{
  "email": "user@example.com",
  "password": "secret"
}
\`\`\`

## Response
\`\`\`json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresIn": 900
}
\`\`\`

## Errors
- 401: Invalid credentials
- 429: Rate limited

## Related
- [artifact:concept-auth] - Auth concepts
- [artifact:api-auth-logout] - Logout`,
  parentId: "<section-api-id>",
  labels: ["api", "auth", "POST"]
})

// ... 30 more API docs
```

**After population**, the channel has 80+ artifacts:

```
list_artifacts({
  channel: "docs-platform-v3"
})
// Returns 80 artifacts - too many for one response
```

**Problem**: Default limit (50) doesn't show all artifacts.

---

## Phase 3: Navigation Challenges

### Challenge 1: Finding Related Docs

**Charlie** needs to find all auth-related docs:

```
list_artifacts({
  channel: "docs-platform-v3",
  search: "auth"
})
```

Returns 12 artifacts across concepts, API, tutorials - good.

But what about finding docs that *link to* a specific doc?

```
// Want: "What docs reference api-auth-login?"
// Current: No way to query incoming references
```

**Gap**: No reverse reference lookup.

### Challenge 2: Navigating Deep Trees

```
▼ docs-root
  ├─ ▼ section-concepts
  │    ├─ concept-auth
  │    ├─ concept-authorization
  │    ├─ concept-entities
  │    │   ├─ concept-users
  │    │   ├─ concept-teams
  │    │   └─ concept-projects
  │    ├─ concept-events
  │    │   ├─ concept-webhooks
  │    │   └─ concept-pubsub
  │    └─ ... (10 more)
  ├─ ▼ section-api
  │    ├─ ▼ api-auth
  │    │    ├─ api-auth-login
  │    │    ├─ api-auth-logout
  │    │    └─ api-auth-refresh
  │    ├─ ▼ api-users
  │    │    ├─ api-users-list
  │    │    ├─ api-users-get
  │    │    └─ api-users-create
  │    └─ ... (20 more groups)
  └─ ... (2 more sections)
```

Tree depth: 4 levels. 80+ nodes.

**Problem**: Agent context window can't hold full tree.
**Problem**: Listing all children of section-api returns 30 items.

### Challenge 3: Cross-Section References

Tutorials reference concepts and API docs:

```
publish_artifact({
  channel: "docs-platform-v3",
  name: "tutorial-auth-setup",
  type: "doc",
  content: `# Tutorial: Setting Up Authentication

## Prerequisites
- Read [artifact:concept-auth]

## Steps
1. Call [artifact:api-auth-login] with credentials
2. Store the accessToken
3. Include in Authorization header
...`,
  parentId: "<section-tutorials-id>",
  labels: ["tutorial", "auth", "beginner"]
})
```

**Problem**: Cross-section references are just text. No tooling to:
- Validate references exist
- Find broken references
- Graph relationships

---

## Phase 4: Maintenance at Scale

### Scenario: API Breaking Change

**Bravo** discovers API change: `/api/auth/login` response changed.

Step 1: Update API doc
```
edit_artifact({
  channel: "docs-platform-v3",
  name: "api-auth-login",
  old_string: '"expiresIn": 900',
  new_string: '"expiresIn": 900,\n  "tokenType": "Bearer"'
})
```

Step 2: Find affected docs
```
// Need to find all docs that reference api-auth-login
list_artifacts({
  channel: "docs-platform-v3",
  search: "api-auth-login"
})
```

Returns: concept-auth, tutorial-auth-setup, troubleshooting-auth-errors

Step 3: Update each manually

**Problem**: Manual process, easy to miss docs.
**Want**: Automatic "docs that reference this changed" notification.

### Scenario: Bulk Label Update

Product decision: All auth docs need `security` label.

```
// Current: Update each artifact individually
publish_artifact({ name: "concept-auth", labels: ["concept", "auth", "security"] })
publish_artifact({ name: "concept-authorization", labels: ["concept", "auth", "security"] })
// ... 10 more
```

**Problem**: No bulk operations.
**Want**: `update_artifacts({ search: "auth", addLabels: ["security"] })`

### Scenario: Version Migration

Platform v4 coming. Need to:
1. Clone v3 docs to v4 section
2. Update version references
3. Keep v3 archived

```
// Current approach: Manual clone
// 1. List all v3 artifacts
list_artifacts({ channel: "docs-platform-v3", labels: ["v3"] })

// 2. Recreate each with v4 label
// 3. Archive v3 versions
```

**Problem**: 80+ artifacts to clone manually.
**Want**: `clone_artifact_tree(root, { newLabels: ["v4"] })`

---

## Phase 5: Query Patterns at Scale

### Pattern 1: Filtered Tree View

"Show me only API docs for auth"

```
list_artifacts({
  channel: "docs-platform-v3",
  parentId: "<section-api-id>",
  search: "auth"
})
```

Works, but limited:
- Can't do AND queries (type=api AND label=auth AND updated-this-week)
- No sorting (alphabetical, by update time, by view count)

### Pattern 2: Recent Changes

"What docs changed this week?"

```
list_artifacts({
  channel: "docs-platform-v3",
  // No date filter available
})
```

**Gap**: No date-based queries.

### Pattern 3: Stale Content Detection

"Find docs not updated in 6 months"

**Gap**: No staleness query.

### Pattern 4: Orphan Detection

"Find docs with no parent (orphans)"

```
list_artifacts({
  channel: "docs-platform-v3",
  parentId: null  // Not supported
})
```

**Gap**: No orphan detection.

### Pattern 5: Broken Reference Check

"Find docs with invalid artifact references"

**Gap**: No reference validation.

---

## Phase 6: Proposed Solutions Discovered

### For Navigation

**1. Pagination**
```
list_artifacts({
  channel: "docs-platform-v3",
  offset: 0,
  limit: 20
})
// Returns page 1 with total count
```

**2. Advanced Filtering**
```
list_artifacts({
  channel: "docs-platform-v3",
  filter: {
    type: "doc",
    labels: { all: ["auth", "api"] },
    updatedAfter: "2025-01-01",
    parentId: "<section-api-id>"
  },
  sort: "updatedAt",
  order: "desc"
})
```

**3. Reference Index**
```
get_artifact_references({
  channel: "docs-platform-v3",
  name: "api-auth-login"
})
// Returns: { incomingRefs: [...], outgoingRefs: [...] }
```

### For Maintenance

**4. Bulk Operations**
```
bulk_update_artifacts({
  channel: "docs-platform-v3",
  filter: { search: "auth" },
  update: { addLabels: ["security"] }
})
```

**5. Clone Tree**
```
clone_artifact({
  channel: "docs-platform-v3",
  name: "docs-root",
  newName: "docs-root-v4",
  recursive: true,
  transformLabels: { v3: "v4" }
})
```

**6. Validation Tool**
```
validate_artifacts({
  channel: "docs-platform-v3",
  checks: ["broken-refs", "orphans", "stale"]
})
// Returns: { brokenRefs: [...], orphans: [...], stale: [...] }
```

### For Context Management

**7. Summary Index**
```
get_artifact_index({
  channel: "docs-platform-v3"
})
// Returns compact summary for agent context:
// { artifacts: 80, tree: { docs-root: [5 children], ... }, labels: [...] }
```

---

## Design Observations

### What Worked

1. **Tree structure** - Parent/child creates navigable hierarchy
2. **Labels for cross-cutting** - `auth`, `api`, `v3` work across tree
3. **Search** - Full-text search is essential at scale
4. **Artifact references** - `[artifact:name]` links create documentation web

### Gaps Identified - Critical for Scale

#### Navigation Gaps

| Gap | Impact | Suggested Fix |
|-----|--------|---------------|
| No pagination | Can't list >50 artifacts | Add `offset`/`limit` |
| No sorting | Can't find recent changes | Add `sort`/`order` |
| No date filters | Can't query by time | Add `updatedAfter`/`updatedBefore` |
| No reference lookup | Can't find "what links here" | Add reference index |
| Single parentId filter | Can't query tree branches | Add `descendantsOf` |

#### Maintenance Gaps

| Gap | Impact | Suggested Fix |
|-----|--------|---------------|
| No bulk operations | 80 updates = 80 tool calls | Add `bulk_update_artifacts` |
| No clone | Version migration painful | Add `clone_artifact` |
| No validation | Broken refs go unnoticed | Add `validate_artifacts` |
| No stale detection | Old docs rot silently | Add staleness queries |

#### Context Management Gaps

| Gap | Impact | Suggested Fix |
|-----|--------|---------------|
| Full tree overwhelms context | Agent can't see big picture | Add compact `get_index` |
| No summary view | Have to fetch each doc | Add `summary` field |
| Discovery injection scales badly | 80 artifacts in system prompt? | Selective injection |

### Scale Thresholds

| Artifact Count | UX Quality | Notes |
|----------------|------------|-------|
| 1-20 | Excellent | Flat list works fine |
| 20-50 | Good | Tree nav helps, search useful |
| 50-100 | Degraded | Need pagination, bulk ops |
| 100-500 | Poor | Need advanced queries, index |
| 500+ | Broken | Need hierarchical summarization |

### Recommended Priority

**P0 - Essential for scale**:
- Pagination (`offset`/`limit`)
- Date-based queries
- Reference index (incoming/outgoing)

**P1 - Highly valuable**:
- Bulk label updates
- Validation (broken refs, orphans)
- Sorting options

**P2 - Nice to have**:
- Clone tree
- Full-text search improvements (fuzzy, relevance scoring)
- Stale content detection

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 80+ | Creating doc corpus |
| `list_artifacts` | 10+ | Navigation, queries |
| `edit_artifact` | 5+ | Updating docs |
| `get_artifact` | 10+ | Reading individual docs |
| `archive_artifact` | 0 | Docs preserved |
| `update_task_status` | 0 | Not task-based workflow |

### New Tools Suggested

| Tool | Purpose |
|------|---------|
| `list_artifacts` (enhanced) | Pagination, sorting, date filters |
| `get_artifact_references` | Incoming/outgoing reference lookup |
| `bulk_update_artifacts` | Mass label/status updates |
| `clone_artifact` | Duplicate with transform |
| `validate_artifacts` | Check refs, orphans, staleness |
| `get_artifact_index` | Compact summary for context |

### New Query Parameters Suggested

| Parameter | Purpose |
|-----------|---------|
| `offset`, `limit` | Pagination |
| `sort`, `order` | Sorting (updatedAt, name, etc.) |
| `updatedAfter`, `updatedBefore` | Date filtering |
| `descendantsOf` | Query subtree |
| `hasLabel`, `missingLabel` | Label queries |
| `orphansOnly` | Find unparented artifacts |
