# Scenario 4: Handoff

> Work transfers between agents across context boundaries (shift change, reassignment, new team member)

## Cast

- **coordinator** - Manages handoffs, ensures continuity
- **alfa** - Outgoing agent (context about to expire / going offline)
- **bravo** - Incoming agent (fresh context, needs onboarding)
- **Human** - Triggers handoff, available for questions

## Channel: #incident-db-outage

---

## Context

An incident is in progress. Alfa has been investigating for 2 hours and has significant context. Alfa's session is about to end (context limit / shift change). Bravo needs to take over without losing progress.

---

## Phase 1: Handoff Triggered

**Human** initiates handoff:
```
@alfa Your shift is ending in 15 minutes. @bravo is coming online to take over.
Please prepare a handoff summary.
```

**Coordinator** creates handoff artifact:

```
publish_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo",
  type: "doc",
  content: `# Handoff: alfa → bravo

**Time**: 2025-01-15 18:00 UTC
**Incident**: Database connection pool exhaustion
**Duration so far**: 2h 15m

## Status
*To be filled by alfa*

## Summary for bravo
*To be filled by alfa*`,
  labels: ["handoff", "in-progress"]
})
```

---

## Phase 2: Outgoing Agent Prepares Handoff

**Alfa** creates comprehensive handoff summary:

```
edit_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo",
  old_string: "## Status\n*To be filled by alfa*\n\n## Summary for bravo\n*To be filled by alfa*",
  new_string: `## Current Status
**Severity**: P1 (production impacted)
**State**: Mitigated, not resolved
**Customer Impact**: ~5% of requests failing

## What Happened
1. 15:45 - Alerts fired: connection pool exhausted on db-primary
2. 16:00 - Identified: Long-running queries from new feature (user-export)
3. 16:30 - Mitigated: Killed long queries, increased pool size temporarily
4. 17:00 - Root cause: Missing index on users.exported_at column
5. 17:45 - Index migration running (ETA: 30 min remaining)

## What I've Done
- [x] Killed blocking queries
- [x] Increased pool from 100→200 (temporary)
- [x] Identified missing index
- [x] Started index migration (running now)
- [ ] Verify index applied
- [ ] Reduce pool back to 100
- [ ] Post-incident review

## What bravo Needs To Do
1. **Monitor index migration** - Check \`SELECT * FROM pg_stat_progress_create_index\`
2. **When complete**: Reduce pool size back to 100
3. **Verify**: Run test user-export, confirm <1s response
4. **Close out**: Update status page, notify stakeholders

## Key Files/Artifacts
- [artifact:incident-timeline] - Full timeline
- [artifact:runbook-pool-sizing] - How to adjust pool
- Grafana dashboard: db-connections (link in channel topic)

## Gotchas
- Don't restart the db service - index migration will abort
- Pool size change requires app restart (rolling deploy)
- Stakeholder @pm-sarah wants update when resolved`
})
```

**Alfa** also updates existing investigation artifacts:

```
edit_artifact({
  channel: "incident-db-outage",
  name: "incident-timeline",
  old_string: "17:45 - Index migration started",
  new_string: `17:45 - Index migration started
18:00 - HANDOFF to bravo (alfa shift end)`
})
```

**Chat message** from alfa:
```
@bravo Handoff ready: [artifact:handoff-alfa-bravo]

Key thing: index migration is running, should finish in ~30 min.
Don't restart anything until it completes. Check pg_stat_progress.

I'll be offline but available on phone if P0 escalation needed.
@coordinator alfa signing off.
```

---

## Phase 3: Incoming Agent Onboards

**Bravo** joins and reviews handoff:

```
get_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo"
})
```

**Bravo** acknowledges and asks clarifying question:

```
@alfa Got it. One question before you go: the pool size change—did you
do that via env var or config file? Need to know for rollback.
```

**Alfa** updates handoff with detail:

```
edit_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo",
  old_string: "- Pool size change requires app restart (rolling deploy)",
  new_string: `- Pool size change requires app restart (rolling deploy)
- Current change: Set via \`DATABASE_POOL_SIZE\` env var in k8s configmap
- Rollback: \`kubectl edit configmap api-config\` → change back to 100`
})
```

**Chat message** from alfa:
```
@bravo Updated handoff with rollback details. Good luck! 🫡
```

**Coordinator** marks handoff complete:

```
edit_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo",
  old_string: `labels: ["handoff", "in-progress"]`,
  new_string: `labels: ["handoff", "completed"]`
})
```

Actually, labels are set differently:
```
publish_artifact({
  channel: "incident-db-outage",
  name: "handoff-alfa-bravo",
  // ... keep existing content ...
  labels: ["handoff", "completed"]
})
```

---

## Phase 4: Incoming Agent Continues Work

**Bravo** monitors and updates as work progresses:

```
publish_artifact({
  channel: "incident-db-outage",
  name: "bravo-notes",
  type: "doc",
  content: `## bravo Session Notes

### 18:15 - Taking over
- Reviewed [artifact:handoff-alfa-bravo]
- Index migration at 60% per pg_stat_progress

### 18:30 - Index complete
- Migration finished successfully
- Verified index exists: \`\\d users\` shows idx_users_exported_at

### 18:35 - Testing
- Ran user-export for test user
- Response time: 450ms (was timing out before)
- ✅ Fix confirmed`,
  parentId: "<handoff-alfa-bravo-id>",
  labels: ["notes"]
})
```

**Bravo** completes remaining tasks:

```
edit_artifact({
  channel: "incident-db-outage",
  name: "bravo-notes",
  old_string: "- ✅ Fix confirmed",
  new_string: `- ✅ Fix confirmed

### 18:45 - Rollback pool size
- Changed DATABASE_POOL_SIZE back to 100
- Rolling restart in progress

### 18:55 - Verification
- All pods restarted
- Connection count stable at ~80/100
- No errors in logs
- ✅ Pool size normalized`
})
```

---

## Phase 5: Incident Resolution

**Bravo** closes out incident:

```
publish_artifact({
  channel: "incident-db-outage",
  name: "incident-resolution",
  type: "doc",
  content: `# Incident Resolution

**Incident**: Database connection pool exhaustion
**Duration**: 3h 10m (15:45 - 18:55 UTC)
**Severity**: P1
**Resolved By**: bravo (handoff from alfa)

## Root Cause
Missing index on \`users.exported_at\` caused full table scans during
user-export feature, blocking connection pool.

## Resolution
1. Added index: \`CREATE INDEX idx_users_exported_at ON users(exported_at)\`
2. Pool size temporarily increased during migration
3. Pool size restored after index applied

## Timeline
See [artifact:incident-timeline] for full details

## Action Items
- [ ] Add index requirement to user-export PR checklist
- [ ] Set up slow query alerting (>5s)
- [ ] Review other tables for similar missing indexes

## Handoff Notes
Incident spanned shift change. Handoff via [artifact:handoff-alfa-bravo]
worked well—bravo had full context to complete resolution.`,
  labels: ["resolution", "post-incident"]
})
```

**Chat message** from bravo:
```
@channel Incident resolved. Index applied, pool size normalized, all green.

@pm-sarah As promised, update: we're all clear. Root cause was missing
database index. Full details in [artifact:incident-resolution].

@alfa Thanks for the thorough handoff—made this seamless.
```

**Final Board view**:
```
incident-timeline (doc) - Full timeline
runbook-pool-sizing (doc) - Pool adjustment guide
▼ handoff-alfa-bravo (doc) [completed]
  └─ bravo-notes (doc) - Session continuation
incident-resolution (doc) [resolution]
```

---

## Design Observations

### What Worked

1. **Handoff as artifact** - Structured summary survives context boundaries
   - Incoming agent has clear starting point
   - Doesn't rely on scrolling through chat history

2. **Edit for live updates** - Alfa added details (rollback instructions) right up until handoff
   - Artifact evolved as questions arose

3. **Child artifacts for continuation** - bravo's notes linked to handoff
   - Creates clear narrative: handoff → continuation → resolution

4. **Artifact references in handoff** - Links to timeline, runbook give bravo full context

5. **Labels for state tracking** - `in-progress` → `completed` visible

### Gaps Identified - Critical for Context Management

1. **No automatic context injection for incoming agent**
   - bravo has to manually `get_artifact` each one
   - Want: "When bravo joins, inject relevant artifacts into context"
   - **Suggestion**: `priority` or `context-required` label that triggers injection?

2. **No handoff template**
   - Coordinator created structure manually
   - Want: Standardized handoff format
   - **Suggestion**: `type: handoff` with structured fields?

3. **Handoff doesn't capture chat context**
   - Important discussion in chat not automatically included
   - bravo can't see alfa's reasoning from chat
   - **Suggestion**: `messageRef` array to pin key messages into handoff?

4. **No "read receipt" on handoff**
   - Coordinator doesn't know if bravo actually read it
   - **Suggestion**: `acknowledged_by` field? Explicit ack tool?

5. **Artifact size vs context limits**
   - Large handoff artifact consumes context budget
   - Need selective injection: summary vs full content
   - **Suggestion**: `summary` field for abbreviated injection?

6. **No handoff chain**
   - If bravo hands off to charlie, no link to previous handoff
   - Want: handoff history for multi-shift incidents
   - **Suggestion**: `previousHandoff` reference?

7. **Outgoing agent's artifact access ends**
   - When alfa goes offline, can they still read/update artifacts?
   - What if bravo needs to ask async question?
   - Consider: agent persistence beyond session?

### Handoff-Specific Patterns

**Naming convention**: `handoff-{from}-{to}` clear and searchable
**Structure**: Status → What happened → What I did → What you do → Gotchas
**Continuation**: Incoming agent's notes as child of handoff

### Context Continuity Challenges

| Challenge | Current State | Desired State |
|-----------|--------------|---------------|
| Chat history | Lost on context reset | Key messages pinned |
| Investigation state | Manual summary | Automatic capture |
| Mental model | Text description | Structured data |
| Verification | Trust handoff | Checkslist/ack |

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 4 | Handoff, notes, resolution |
| `edit_artifact` | 4 | Update handoff with details, notes with progress |
| `get_artifact` | 1 | bravo reading handoff |
| `update_task_status` | 0 | Not task-based workflow |
| `list_artifacts` | 0 | Direct artifact access via names |

### New Tools Suggested

| Tool | Purpose |
|------|---------|
| `create_handoff` | Structured handoff with template |
| `acknowledge_handoff` | Explicit read receipt |
| `pin_messages` | Capture key chat context into artifact |
| `get_artifact_summary` | Abbreviated content for context injection |

### New Artifact Fields Suggested

| Field | Purpose |
|-------|---------|
| `summary` | Short version for context injection |
| `priority` | High-priority artifacts auto-injected |
| `acknowledgedBy` | Who has read/acknowledged |
| `previousHandoff` | Chain for multi-shift scenarios |
