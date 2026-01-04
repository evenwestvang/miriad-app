# Scenario 3: Design Review

> A team reviews a proposed architecture, collecting feedback and reaching consensus

## Cast

- **coordinator** - Facilitates review, synthesizes feedback, drives decisions
- **alfa** - Reviewer, focuses on security concerns
- **bravo** - Reviewer, focuses on performance/scalability
- **charlie** - Original author, defends/revises proposal
- **Human** - Final approver, breaks ties

## Channel: #review-api-redesign

---

## Phase 1: Proposal Submission

**Charlie** submits architecture proposal for review:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "proposal-api-v2",
  type: "doc",
  content: `# API v2 Architecture Proposal

**Author**: charlie
**Status**: Under Review
**Requested Reviewers**: alfa, bravo

## Summary
Redesign our REST API to support GraphQL alongside REST, with a unified resolver layer.

## Current State
- REST-only API
- Controllers directly query database
- No caching layer
- 50+ endpoints, some redundant

## Proposed Architecture

\`\`\`
┌─────────────┐  ┌─────────────┐
│   REST      │  │  GraphQL    │
│   Routes    │  │  Schema     │
└──────┬──────┘  └──────┬──────┘
       │                │
       └───────┬────────┘
               ▼
       ┌───────────────┐
       │   Resolver    │
       │     Layer     │
       └───────┬───────┘
               ▼
       ┌───────────────┐
       │    Cache      │
       │   (Redis)     │
       └───────┬───────┘
               ▼
       ┌───────────────┐
       │   Database    │
       │  (Postgres)   │
       └───────────────┘
\`\`\`

## Key Changes
1. Unified resolver layer shared by REST and GraphQL
2. Redis caching for hot paths
3. Deprecate 15 redundant REST endpoints
4. GraphQL for complex queries, REST for simple CRUD

## Migration Plan
- Phase 1: Add resolver layer behind REST (no API changes)
- Phase 2: Add GraphQL endpoint
- Phase 3: Deprecation notices on old endpoints
- Phase 4: Remove deprecated endpoints (v3)

## Open Questions
- Redis cluster or single instance?
- GraphQL subscriptions needed?
- Rate limiting strategy?`,
  status: "draft",
  labels: ["proposal", "needs-review", "architecture"]
})
```

**Coordinator** creates review tracking artifact:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "review-tracker",
  type: "task",
  content: `## Review Status

| Reviewer | Status | Focus Area |
|----------|--------|------------|
| alfa     | pending | Security |
| bravo    | pending | Performance |

**Blocking**: Needs 2 approvals to proceed

**Deadline**: EOD Friday`,
  taskStatus: "in_progress",
  assignees: ["alfa", "bravo"],
  parentId: "<proposal-api-v2-id>"
})
```

**Board view**:
```
▼ proposal-api-v2 (doc, draft) [needs-review]
  └─ review-tracker (task, in_progress) @alfa @bravo
```

---

## Phase 2: Security Review

**Alfa** reviews and creates feedback artifact:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "review-alfa-security",
  type: "doc",
  content: `## Security Review - alfa

**Verdict**: Request Changes

### Concerns

#### 1. GraphQL Complexity Attacks (Critical)
Deeply nested queries can cause DoS:
\`\`\`graphql
query {
  users {
    posts {
      comments {
        author {
          posts {
            comments { ... }
          }
        }
      }
    }
  }
}
\`\`\`

**Recommendation**: Add query depth limiting and complexity scoring.

#### 2. Cache Invalidation (High)
Redis cache + database = potential stale data security issues.
- User permissions cached → permission changes not immediate
- Session data cached → logout may not invalidate

**Recommendation**:
- Never cache auth/permission data
- Or implement pub/sub invalidation

#### 3. GraphQL Introspection (Medium)
Introspection exposes full schema to attackers.

**Recommendation**: Disable introspection in production.

### Approved Aspects
- Unified resolver layer is good for consistent authz
- Deprecation approach is sensible

### Verdict
Cannot approve until complexity attacks addressed.`,
  parentId: "<proposal-api-v2-id>",
  labels: ["review", "security", "request-changes"]
})
```

**Chat message** from alfa:
```
@charlie Posted security review [artifact:review-alfa-security].
Main blocker: GraphQL complexity attacks need mitigation before I can approve.
```

---

## Phase 3: Performance Review

**Bravo** reviews in parallel:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "review-bravo-perf",
  type: "doc",
  content: `## Performance Review - bravo

**Verdict**: Approve with Comments

### Analysis

#### Resolver Layer Overhead
Additional abstraction = ~2-5ms per request.
- Acceptable for most endpoints
- Hot paths (auth, health) should bypass

**Suggestion**: Fast-path option for latency-critical routes.

#### Redis Caching
Good for read-heavy workloads (our case: 80% reads).

Numbers (estimated):
| Scenario | Current | With Cache |
|----------|---------|------------|
| User lookup | 15ms | 2ms |
| List posts | 45ms | 8ms |
| Complex query | 200ms | 150ms (partial) |

**Concern**: Cache warming on cold start could spike DB.
**Suggestion**: Lazy population, not eager warming.

#### GraphQL N+1
Classic problem with nested queries.

**Requirement**: DataLoader pattern mandatory.
\`\`\`typescript
// Bad: N+1 queries
posts.map(p => db.query('SELECT * FROM users WHERE id = ?', p.authorId))

// Good: Batched
const authors = await userLoader.loadMany(posts.map(p => p.authorId))
\`\`\`

### Verdict
Approve with above comments addressed. No blockers.`,
  parentId: "<proposal-api-v2-id>",
  labels: ["review", "performance", "approved"]
})
```

**Coordinator** updates tracker:

```
edit_artifact({
  channel: "review-api-redesign",
  name: "review-tracker",
  old_string: "| alfa     | pending | Security |",
  new_string: "| alfa     | ❌ changes requested | Security |"
})

edit_artifact({
  channel: "review-api-redesign",
  name: "review-tracker",
  old_string: "| bravo    | pending | Performance |",
  new_string: "| bravo    | ✅ approved | Performance |"
})
```

**Board view**:
```
▼ proposal-api-v2 (doc, draft) [needs-review]
  ├─ review-tracker (task, in_progress)
  ├─ review-alfa-security (doc) [request-changes]
  └─ review-bravo-perf (doc) [approved]
```

---

## Phase 4: Author Response

**Charlie** addresses feedback with revisions:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "response-to-alfa",
  type: "doc",
  content: `## Response to Security Review

@alfa addressing your concerns:

### 1. GraphQL Complexity Attacks ✅ Fixed

Adding to proposal:
\`\`\`typescript
// graphql-depth-limit
const depthLimit = require('graphql-depth-limit')

// graphql-query-complexity
const complexity = require('graphql-query-complexity')

app.use('/graphql', createHandler({
  validationRules: [
    depthLimit(7),
    createComplexityValidator({ maxComplexity: 1000 })
  ]
}))
\`\`\`

### 2. Cache Invalidation ✅ Fixed

Revised approach:
- Auth/session data: NEVER cached
- Permissions: Short TTL (30s) + pub/sub invalidation
- Content: Standard caching with longer TTL

### 3. Introspection ✅ Fixed

\`\`\`typescript
const server = new ApolloServer({
  introspection: process.env.NODE_ENV !== 'production'
})
\`\`\`

Ready for re-review.`,
  parentId: "<review-alfa-security-id>",
  labels: ["response"]
})
```

**Charlie** updates the main proposal:

```
edit_artifact({
  channel: "review-api-redesign",
  name: "proposal-api-v2",
  old_string: "## Open Questions\n- Redis cluster or single instance?\n- GraphQL subscriptions needed?\n- Rate limiting strategy?",
  new_string: `## Security Measures
- Query depth limit: 7 levels max
- Query complexity scoring: 1000 point max
- Introspection disabled in production
- Auth/session data never cached
- Permissions: 30s TTL with pub/sub invalidation

## Open Questions
- Redis cluster or single instance?
- GraphQL subscriptions needed?
- Rate limiting strategy?`
})
```

**Chat message** from charlie:
```
@alfa Updated proposal with security measures. See [artifact:response-to-alfa]
for details. Ready for re-review when you have time.
```

---

## Phase 5: Re-Review and Approval

**Alfa** re-reviews and updates verdict:

```
edit_artifact({
  channel: "review-api-redesign",
  name: "review-alfa-security",
  old_string: "**Verdict**: Request Changes",
  new_string: "**Verdict**: ✅ Approved (after revision)"
})

edit_artifact({
  channel: "review-api-redesign",
  name: "review-alfa-security",
  old_string: "Cannot approve until complexity attacks addressed.",
  new_string: "All concerns addressed in revision. Approved."
})
```

**Coordinator** updates tracker:

```
edit_artifact({
  channel: "review-api-redesign",
  name: "review-tracker",
  old_string: "| alfa     | ❌ changes requested | Security |",
  new_string: "| alfa     | ✅ approved (v2) | Security |"
})
```

**Board view**:
```
▼ proposal-api-v2 (doc, draft) [needs-review]
  ├─ review-tracker (task, in_progress)
  ├─ ▼ review-alfa-security (doc) [approved]
  │    └─ response-to-alfa (doc) [response]
  └─ review-bravo-perf (doc) [approved]
```

---

## Phase 6: Decision and Sign-off

**Coordinator** synthesizes and creates decision artifact:

```
publish_artifact({
  channel: "review-api-redesign",
  name: "decision-api-v2",
  type: "decision",
  content: `## Decision: API v2 Architecture

**Status**: Approved

**Reviewers**:
- alfa (Security): ✅ Approved
- bravo (Performance): ✅ Approved

**Summary of Changes from Original**:
1. Added GraphQL query depth/complexity limits
2. Auth data excluded from caching
3. Introspection disabled in production
4. DataLoader pattern required for N+1 prevention
5. Fast-path option for latency-critical routes

**Conditions**:
- DataLoader implementation must be reviewed separately
- Load testing required before GraphQL goes live
- Security audit on resolver layer before Phase 2

**Next Steps**:
1. Charlie to create implementation tasks
2. Target Phase 1 completion: 2 sprints
3. Follow-up review after Phase 1`,
  parentId: "<proposal-api-v2-id>",
  labels: ["decision", "approved"]
})
```

**Coordinator** marks review complete:

```
update_task_status({
  channel: "review-api-redesign",
  name: "review-tracker",
  taskStatus: "done"
})

edit_artifact({
  channel: "review-api-redesign",
  name: "proposal-api-v2",
  old_string: "**Status**: Under Review",
  new_string: "**Status**: ✅ Approved"
})

publish_artifact({
  channel: "review-api-redesign",
  name: "proposal-api-v2",
  status: "published"  // Upgrade from draft
})
```

**Human** adds final sign-off in chat:
```
@channel Approved. Good review cycle - security concerns were caught early
and addressed well. Charlie, proceed with implementation.
```

**Final Board view**:
```
▼ proposal-api-v2 (doc, published) [approved]
  ├─ ✓ review-tracker (task, done)
  ├─ ▼ review-alfa-security (doc) [approved]
  │    └─ response-to-alfa (doc)
  ├─ review-bravo-perf (doc) [approved]
  └─ decision-api-v2 (decision) [approved]
```

---

## Design Observations

### What Worked

1. **Review as child artifacts** - Feedback attached to proposal, easy to find all reviews

2. **Response threading** - Author response as child of review creates clear dialogue

3. **Labels for verdict tracking** - `request-changes`, `approved` visible at glance

4. **Review tracker artifact** - Single place to see who reviewed, who's pending

5. **Decision artifact captures outcome** - Summary of what changed and why

6. **Edit for revisions** - `edit_artifact` updates proposal in place, preserving identity

### Gaps Identified

1. **No diff between versions** - Can't easily see what charlie changed in proposal
   - Want: "Show me diff between original and current"
   - **Critical for reviews**

2. **No formal approval workflow** - Manually tracking approvals in text
   - Consider: `approval` field on artifacts? `approve_artifact` tool?

3. **No notification on changes** - alfa doesn't know proposal was updated
   - Need: "Notify reviewers when artifact they reviewed changes"

4. **Review assignment is informal** - No structured way to request review
   - Consider: `requestReview: string[]` field?

5. **No blocking/unblocking semantics** - "2 approvals required" is text, not enforced
   - Consider: `requiredApprovals: number` for gating?

6. **Stale review detection** - If proposal changes significantly, old reviews may be invalid
   - Need: "Review was on version X, proposal now version Y"

7. **No inline comments** - All feedback is document-level
   - Consider: Line-specific comments like GitHub?
   - Or: Accept that artifacts are smaller than files, doc-level is fine

### Review-Specific Patterns

**Review Artifact Naming**: `review-{reviewer}-{focus}` works well
**Response Threading**: `response-to-{review}` as child clear
**Decision Capture**: Separate decision artifact > editing proposal status

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 7 | Proposal, tracker, reviews, response, decision |
| `edit_artifact` | 6 | Update verdicts, tracker, proposal |
| `update_task_status` | 1 | Complete review tracker |
| `list_artifacts` | - | Not needed in this flow |
| `get_artifact` | - | Not needed (navigation via tree) |

### New Tools Suggested

| Tool | Purpose |
|------|---------|
| `get_artifact_diff` | Compare versions of same artifact |
| `request_review` | Formally assign reviewers with notifications |
| `approve_artifact` | Structured approval with optional blocking |
