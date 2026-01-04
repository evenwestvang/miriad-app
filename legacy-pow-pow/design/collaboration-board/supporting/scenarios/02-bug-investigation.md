# Scenario 2: Bug Investigation

> A scout investigates a production issue, documents findings, and the team decides on a fix

## Cast

- **alfa** - Scout, investigates the bug
- **coordinator** - Reviews findings, makes decisions
- **bravo** - Scout, implements the fix
- **Human** - Reports initial bug, monitors progress

## Channel: #incident-prod-500

---

## Phase 1: Bug Report

**Human** reports in chat:
```
@channel Production returning 500 errors on checkout. Started ~10 minutes ago.
Error rate spiking. Need someone to investigate ASAP.
```

**Coordinator** creates tracking artifact:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "incident-tracker",
  type: "doc",
  content: `## Incident: Production 500 Errors

**Reported**: 2025-01-15 14:30 UTC
**Reporter**: Human
**Severity**: High
**Status**: Investigating

### Timeline
- 14:30 - Error rate spike detected
- 14:32 - Incident channel created

### Symptoms
- 500 errors on /api/checkout
- Started ~10 minutes before report`,
  status: "draft",
  labels: ["incident", "high-severity"]
})
```

**Coordinator** assigns:
```
@alfa Please investigate. Create findings artifact as you go.
```

---

## Phase 2: Investigation

**Alfa** starts investigating, creates findings artifact:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "findings-initial",
  type: "doc",
  content: `## Investigation Findings

### Logs
Checked CloudWatch logs for api-checkout service:
\`\`\`
ERROR 14:22:03 PaymentService.processPayment: Connection refused to payment-gateway:443
ERROR 14:22:03 CheckoutHandler: Payment failed - Error: ECONNREFUSED
\`\`\`

### Observation
Payment gateway connections failing. Not a code issue - external dependency.`,
  parentId: "<incident-tracker-id>",
  labels: ["investigation"]
})
```

**Alfa** adds code reference:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "code-ref-payment",
  type: "code",
  content: `## Relevant Code

File: src/services/payment.ts:45-60

\`\`\`typescript
async processPayment(order: Order): Promise<PaymentResult> {
  // No retry logic - single attempt
  const response = await this.gateway.charge(order.total);
  if (!response.ok) {
    throw new Error(\`Payment failed: \${response.error}\`);
  }
  return response;
}
\`\`\`

**Issue**: No retry logic, no circuit breaker. Single connection failure = 500 to user.`,
  parentId: "<findings-initial-id>",
  labels: ["code-ref"]
})
```

**Board view**:
```
▼ incident-tracker (doc, draft) - Investigating
  └─ ▼ findings-initial (doc) - Investigation Findings
       └─ code-ref-payment (code) - Payment service code
```

---

## Phase 3: Root Cause Identified

**Alfa** updates findings with root cause:

```
edit_artifact({
  channel: "incident-prod-500",
  name: "findings-initial",
  old_string: "### Observation\nPayment gateway connections failing. Not a code issue - external dependency.",
  new_string: `### Observation
Payment gateway connections failing. Not a code issue - external dependency.

### Root Cause
1. **Immediate**: Payment gateway had a 3-minute outage (14:20-14:23)
2. **Contributing**: Our code has no retry/circuit breaker, so transient failures cascade

### Impact
- ~200 failed checkouts during outage window
- Users saw 500 errors instead of graceful degradation`
})
```

**Chat message** from alfa:
```
@coordinator Root cause identified. See [artifact:findings-initial].

TL;DR: Payment gateway blip + no retry logic in our code.
Gateway is back up, errors stopped. But we should fix the resilience issue.
```

---

## Phase 4: Decision

**Coordinator** creates decision artifact:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "decision-fix-approach",
  type: "decision",
  content: `## Decision: Payment Service Resilience

**Context**: Checkout failed during payment gateway outage due to missing retry logic.

**Options Considered**:

1. **Add retry with exponential backoff**
   - Pros: Simple, handles transient failures
   - Cons: Still fails if outage is prolonged

2. **Add circuit breaker pattern**
   - Pros: Fails fast when gateway is down, graceful degradation
   - Cons: More complex, need to decide fallback behavior

3. **Both retry + circuit breaker**
   - Pros: Best resilience
   - Cons: Most implementation effort

**Decision**: Option 3 - Implement both

**Rationale**: Payment is critical path. Worth the extra effort for proper resilience.

**Action Items**:
- Retry: 3 attempts, exponential backoff (100ms, 200ms, 400ms)
- Circuit breaker: Open after 5 failures in 30s, half-open after 60s
- Fallback: Queue payment for retry, show "processing" to user`,
  parentId: "<incident-tracker-id>",
  labels: ["decision", "architecture"]
})
```

---

## Phase 5: Task Creation

**Coordinator** creates fix tasks:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "task-add-retry",
  type: "task",
  content: "Add retry logic to PaymentService.processPayment() per decision-fix-approach",
  taskStatus: "pending",
  assignees: ["bravo"],
  parentId: "<decision-fix-approach-id>"
})

publish_artifact({
  channel: "incident-prod-500",
  name: "task-add-circuit-breaker",
  type: "task",
  content: "Implement circuit breaker for payment gateway calls",
  taskStatus: "pending",
  assignees: ["bravo"],
  parentId: "<decision-fix-approach-id>"
})

publish_artifact({
  channel: "incident-prod-500",
  name: "task-add-fallback",
  type: "task",
  content: "Implement payment queue fallback for graceful degradation",
  taskStatus: "pending",
  assignees: ["bravo"],
  parentId: "<decision-fix-approach-id>"
})
```

**Board view** (full tree):
```
▼ incident-tracker (doc, draft) - Investigating
  ├─ ▼ findings-initial (doc) - Root cause identified
  │    └─ code-ref-payment (code) - Payment service code
  └─ ▼ decision-fix-approach (decision) - Implement retry + circuit breaker
       ├─ task-add-retry (task, pending) @bravo
       ├─ task-add-circuit-breaker (task, pending) @bravo
       └─ task-add-fallback (task, pending) @bravo
```

---

## Phase 6: Fix Implementation

**Bravo** works through tasks:

```
update_task_status({ channel: "incident-prod-500", name: "task-add-retry", taskStatus: "in_progress" })

// ... implements retry logic ...

update_task_status({ channel: "incident-prod-500", name: "task-add-retry", taskStatus: "done" })
update_task_status({ channel: "incident-prod-500", name: "task-add-circuit-breaker", taskStatus: "in_progress" })

// ... implements circuit breaker ...

update_task_status({ channel: "incident-prod-500", name: "task-add-circuit-breaker", taskStatus: "done" })
update_task_status({ channel: "incident-prod-500", name: "task-add-fallback", taskStatus: "in_progress" })

// ... implements fallback ...

update_task_status({ channel: "incident-prod-500", name: "task-add-fallback", taskStatus: "done" })
```

---

## Phase 7: Resolution

**Coordinator** updates incident tracker:

```
edit_artifact({
  channel: "incident-prod-500",
  name: "incident-tracker",
  old_string: "**Status**: Investigating",
  new_string: "**Status**: Resolved"
})

edit_artifact({
  channel: "incident-prod-500",
  name: "incident-tracker",
  old_string: "- 14:32 - Incident channel created",
  new_string: `- 14:32 - Incident channel created
- 14:45 - Root cause identified (payment gateway outage + no retry logic)
- 15:00 - Decision made: implement retry + circuit breaker
- 16:30 - Fix deployed to production
- 16:35 - Incident resolved`
})
```

**Coordinator** publishes incident as official record:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "incident-tracker",
  type: "doc",
  content: "...",  // Current content preserved
  status: "published"  // Upgrade from draft
})
```

---

## Phase 8: Pin Key Moments

**Coordinator** pins the critical chat message:

```
publish_artifact({
  channel: "incident-prod-500",
  name: "pin-initial-report",
  type: "pin",
  content: "Initial bug report from Human",
  messageRef: "<original-message-id>",
  parentId: "<incident-tracker-id>"
})
```

**Human** uses search to find all decisions:

```
list_artifacts({
  channel: "incident-prod-500",
  type: "decision"
})
```

**Human** searches for "circuit breaker" across all content:

```
list_artifacts({
  channel: "incident-prod-500",
  search: "circuit breaker"
})
```

Returns: `decision-fix-approach`, `task-add-circuit-breaker`

---

## Design Observations

### What Worked

1. **Draft → Published lifecycle** - Incident starts as draft (evolving), becomes published (official record)

2. **Deep nesting** - Natural hierarchy: incident → findings → code refs, incident → decision → tasks

3. **Pins** - Capture ephemeral chat moments as durable artifacts

4. **Search** - Quick way to find relevant artifacts across content

5. **Surgical edits** - Timeline updates don't require full republish

### Gaps Identified

1. **No artifact history** - Can't see what findings looked like before update
   - Critical for post-mortems: "what did we know when?"
   - Consider: Version history endpoint

2. **Timestamp confusion** - Artifact `updatedAt` vs timeline in content
   - Need discipline to keep timeline in sync
   - Consider: Structured timeline field?

3. **Cross-channel references for recurring issues**
   - If similar incident happened before, want to link
   - `[artifact:#incident-2024-12/findings]` works but verbose
   - Consider: Short reference syntax?

4. **No bulk operations** - Creating 3 tasks = 3 separate calls
   - Consider: `batch_publish` or array support in `publish_artifact`?

5. **Pin lacks context** - Just stores message ID, need to fetch message separately
   - Consider: Inline message content in pin artifact?

---

## Tool Usage Summary

| Tool | Count | Purpose |
|------|-------|---------|
| `publish_artifact` | 9 | Tracker, findings, code refs, decision, tasks, pin |
| `edit_artifact` | 3 | Update findings, update tracker status/timeline |
| `update_task_status` | 6 | Task lifecycle |
| `list_artifacts` | 2 | Human queries |
| `get_artifact` | - | Not needed in this flow |
| `archive_artifact` | - | Not used (incident preserved) |
