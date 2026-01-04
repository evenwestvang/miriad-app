# Scenario 1: Feature Development

> A team builds an auth feature from spec to completion using artifacts for coordination

## Cast

- **coordinator** - Orchestrates work, creates specs and tasks
- **alfa** - Scout, implements backend
- **bravo** - Scout, implements frontend
- **Human** - Reviews progress in Board view

## Channel: #feature-auth

---

## Phase 1: Spec Creation

**Coordinator** creates the feature spec:

```
publish_artifact({
  channel: "feature-auth",
  name: "auth-spec",
  type: "doc",
  content: `## Auth Feature Spec

### Requirements
- JWT-based authentication
- Login/logout endpoints
- Token refresh flow
- 15-minute access token, 7-day refresh token

### API Endpoints
- POST /api/auth/login
- POST /api/auth/logout
- POST /api/auth/refresh

### Security
- Passwords hashed with bcrypt
- Tokens stored in httpOnly cookies
- CSRF protection on all mutations`,
  status: "published"
})
```

**Board view** shows:
```
auth-spec (doc, published) - Auth feature specification
```

---

## Phase 2: Task Breakdown

**Coordinator** creates tasks as child artifacts:

```
publish_artifact({
  channel: "feature-auth",
  name: "task-login-endpoint",
  type: "task",
  content: "Implement POST /api/auth/login per auth-spec",
  taskStatus: "pending",
  assignees: ["alfa"],
  parentId: "<auth-spec-id>"
})

publish_artifact({
  channel: "feature-auth",
  name: "task-logout-endpoint",
  type: "task",
  content: "Implement POST /api/auth/logout per auth-spec",
  taskStatus: "pending",
  assignees: ["alfa"],
  parentId: "<auth-spec-id>"
})

publish_artifact({
  channel: "feature-auth",
  name: "task-login-ui",
  type: "task",
  content: "Build login form component per auth-spec",
  taskStatus: "pending",
  assignees: ["bravo"],
  parentId: "<auth-spec-id>"
})
```

**Board view** (tree expanded):
```
▼ auth-spec (doc, published)
  ├─ task-login-endpoint (task, pending) @alfa
  ├─ task-logout-endpoint (task, pending) @alfa
  └─ task-login-ui (task, pending) @bravo
```

---

## Phase 3: Parallel Work

**Alfa** claims and starts work:

```
update_task_status({
  channel: "feature-auth",
  name: "task-login-endpoint",
  taskStatus: "in_progress"
})
```

**Bravo** claims their task:

```
update_task_status({
  channel: "feature-auth",
  name: "task-login-ui",
  taskStatus: "in_progress"
})
```

**Chat message** from alfa:
```
@coordinator Started on login endpoint. Quick q: should we support
email OR username login, or just email?

See [artifact:auth-spec] for current spec.
```

**Coordinator** updates spec using surgical edit:

```
edit_artifact({
  channel: "feature-auth",
  name: "auth-spec",
  old_string: "- POST /api/auth/login",
  new_string: "- POST /api/auth/login (accepts email OR username)"
})
```

---

## Phase 4: Progress Updates

**Alfa** completes login, adds implementation notes:

```
publish_artifact({
  channel: "feature-auth",
  name: "impl-login",
  type: "code",
  content: `## Login Implementation Notes

- Used bcrypt with cost factor 12
- JWT signed with RS256
- Tokens set as httpOnly cookies
- Rate limited: 5 attempts per minute per IP

File: src/api/auth/login.ts`,
  parentId: "<task-login-endpoint-id>"
})

update_task_status({
  channel: "feature-auth",
  name: "task-login-endpoint",
  taskStatus: "done"
})
```

**Board view** (tree expanded):
```
▼ auth-spec (doc, published)
  ├─ ✓ task-login-endpoint (task, done) @alfa
  │   └─ impl-login (code) - Implementation notes
  ├─ task-logout-endpoint (task, pending) @alfa
  └─ ◐ task-login-ui (task, in_progress) @bravo
```

---

## Phase 5: Blocker and Resolution

**Bravo** hits a blocker:

```
update_task_status({
  channel: "feature-auth",
  name: "task-login-ui",
  taskStatus: "blocked"
})
```

**Chat message** from bravo:
```
@coordinator Blocked on login UI. Need CORS config for local dev.
The API returns 403 on preflight requests.
```

**Coordinator** creates a decision artifact:

```
publish_artifact({
  channel: "feature-auth",
  name: "decision-cors",
  type: "decision",
  content: `## Decision: CORS Configuration

**Problem**: Frontend dev server blocked by CORS

**Decision**: Add dev-only CORS headers
- Allow localhost:3000 in development
- Strict origin checking in production

**Rationale**: Unblocks frontend dev without compromising prod security`,
  labels: ["urgent"]
})
```

**Alfa** implements CORS fix, **bravo** unblocks:

```
update_task_status({
  channel: "feature-auth",
  name: "task-login-ui",
  taskStatus: "in_progress"
})
```

---

## Phase 6: Human Review

**Human** opens Board view, filters to see all tasks:

```
list_artifacts({
  channel: "feature-auth",
  type: "task"
})
```

**Human** searches for blocked items:

```
list_artifacts({
  channel: "feature-auth",
  search: "blocked"
})
```

**Human** navigates tree from chat link:
- Clicks `[artifact:auth-spec]` in chat
- Board view focuses on auth-spec
- Expands to see child tasks
- Clicks task to see implementation notes

---

## Phase 7: Completion

All tasks done. **Coordinator** marks spec as complete:

```
edit_artifact({
  channel: "feature-auth",
  name: "auth-spec",
  old_string: "## Auth Feature Spec",
  new_string: "## Auth Feature Spec\n\n**Status: COMPLETE** - Implemented 2025-01-15"
})
```

**Final Board view**:
```
▼ auth-spec (doc, published) - COMPLETE
  ├─ ✓ task-login-endpoint (task, done)
  │   └─ impl-login (code)
  ├─ ✓ task-logout-endpoint (task, done)
  └─ ✓ task-login-ui (task, done)

decision-cors (decision) - CORS Configuration
```

---

## Design Observations

### What Worked

1. **Tree structure** - Parent/child relationships create natural hierarchy from spec → tasks → implementation notes

2. **Task lifecycle** - Status transitions (pending → in_progress → blocked → done) visible at a glance

3. **Surgical edits** - `edit_artifact` lets coordinator update spec without full rewrite

4. **Artifact links** - `[artifact:auth-spec]` in chat connects discussion to durable outputs

### Gaps Identified

1. **No task dependencies** - Can't express "task B depends on task A"
   - Workaround: Use labels like `blocked-by:task-a`

2. **No notifications on artifact changes** - Agents don't get notified when spec updates
   - Need: SSE artifact events should @mention assignees?

3. **No artifact comments** - Discussion happens in chat, not attached to artifact
   - Workaround: Child artifacts as "comment threads"
   - Consider: Lightweight comment type?

4. **Assignee changes need full republish** - Can't just update assignees
   - `updateArtifact` supports partial updates, but MCP tool exposes full publish
   - Consider: `assign_task` convenience tool?

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 7 | Create spec, tasks, impl notes, decision |
| `update_task_status` | 6 | Lifecycle transitions |
| `edit_artifact` | 2 | Update spec content |
| `list_artifacts` | 2 | Human querying Board view |
| `get_artifact` | - | Not needed (tree nav via list) |
