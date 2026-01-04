# Scenario 5: Cross-Team Collaboration

Two teams working on related features need to share specifications and coordinate across channel boundaries.

## Setup

- **#backend** channel: Building user API
- **#frontend** channel: Building user dashboard
- Backend team creates API spec, frontend team needs to consume it

## Walkthrough

### Phase 1: Backend Team Creates API Spec

**In #backend:**

```
coordinator: @alfa We need to design the user API. Create a spec artifact.

alfa: On it.
```

Alfa creates the artifact:
```typescript
publish_artifact({
  channel: "backend",
  name: "user-api-spec",
  type: "doc",
  content: `# User API Specification

## Endpoints

### GET /api/users/:id
Returns user profile data.

Response:
{
  "id": "string",
  "name": "string",
  "email": "string",
  "createdAt": "ISO8601"
}

### PUT /api/users/:id
Updates user profile.

Request body:
{
  "name": "string",
  "email": "string"
}
`,
  sender: "alfa"
})
```

Alfa announces in chat:
```
alfa: @channel API spec ready: [artifact:user-api-spec]
```

### Phase 2: Frontend Team Discovers the Spec

**In #frontend:**

Human coordinator notices backend progress and references it:
```
simen: @channel Backend has their API spec ready. Reference it at #backend/user-api-spec when building the dashboard components.
```

Frontend scout reads the cross-channel artifact:
```typescript
get_artifact({
  channel: "#backend",  // Note: # prefix for cross-channel
  name: "user-api-spec"
})
```

Scout creates a local artifact that references the backend spec:
```typescript
publish_artifact({
  channel: "frontend",
  name: "dashboard-integration",
  type: "doc",
  content: `# Dashboard Integration Plan

Based on backend API spec: #backend/user-api-spec

## Components Needed

1. **UserProfile** - displays GET /api/users/:id response
2. **ProfileEditor** - form for PUT /api/users/:id

## Data Mapping

| API Field | Component Prop |
|-----------|---------------|
| id        | userId        |
| name      | displayName   |
| email     | contactEmail  |
| createdAt | memberSince   |
`,
  sender: "fox"
})
```

### Phase 3: API Change Requires Coordination

Backend team adds a field:
```typescript
edit_artifact({
  channel: "backend",
  name: "user-api-spec",
  old_string: `"createdAt": "ISO8601"
}`,
  new_string: `"createdAt": "ISO8601",
  "avatarUrl": "string | null"
}`,
  sender: "alfa"
})
```

Alfa notifies frontend via chat:
```
alfa: @channel Heads up #frontend - added avatarUrl to user response. See [artifact:user-api-spec]
```

**In #frontend**, the coordinator sees the message (via cross-channel mention or human relay):
```
coordinator: @fox Backend added avatarUrl. Update our integration plan.
```

Fox updates the local artifact:
```typescript
edit_artifact({
  channel: "frontend",
  name: "dashboard-integration",
  old_string: `| createdAt | memberSince   |`,
  new_string: `| createdAt | memberSince   |
| avatarUrl | profileImage  |`,
  sender: "fox"
})
```

### Phase 4: Human Reviews Cross-Team State

**In Board view:**

Human opens #frontend Board, sees:
- `dashboard-integration` (doc) - local spec

Clicks the `#backend/user-api-spec` reference in the content → Board navigates to #backend channel, focuses on `user-api-spec`

Human can now see both teams' artifacts and verify alignment.

## Tools Used

| Tool | Purpose |
|------|---------|
| `publish_artifact` | Create specs in each channel |
| `get_artifact` with `#channel` prefix | Read cross-channel artifacts |
| `edit_artifact` | Update specs as requirements evolve |
| `[artifact:name]` in chat | Reference artifacts for teammates |
| Board view | Human navigates artifact tree across channels |

## Design Gaps Identified

### 1. Cross-Channel Notifications
When backend updates their spec, frontend team has no automatic notification. Currently relies on:
- Manual chat message
- Human monitoring multiple channels

**Potential solution**: "Watch" artifacts across channels, get notified on changes.

### 2. Reference Integrity
If backend renames or deletes `user-api-spec`, frontend's reference `#backend/user-api-spec` breaks silently.

**Potential solution**: Track references, warn on breaking changes, or use artifact IDs instead of names for cross-channel refs.

### 3. Cross-Channel Search
Can't search for artifacts mentioning "user" across all channels from Board view.

**Potential solution**: Global artifact search (already in future.md as deferred).

### 4. Permission Boundaries
Currently: if you can see the channel, you can read its artifacts. What about sensitive channels?

**Potential solution**: Artifact-level visibility overrides (already in Open Questions).

## Simplification Opportunities

### 1. Unified Reference Syntax
Both chat and artifact content use `#channel/artifact-name`. Consider also supporting just `artifact-name` for same-channel refs and `#channel/artifact-name` for cross-channel—currently ambiguous whether `[artifact:name]` requires the channel prefix.

**Recommendation**: `[artifact:name]` for same-channel, `[artifact:#channel/name]` for cross-channel. Explicit and consistent.

### 2. Artifact Aliasing
Frontend could create a local alias to backend's spec:
```typescript
publish_artifact({
  name: "api-spec",
  type: "alias",
  content: "#backend/user-api-spec"
})
```

Then reference `[artifact:api-spec]` locally instead of the full path. Alias resolves to target.

**Adds complexity, defer unless pain point emerges.**
