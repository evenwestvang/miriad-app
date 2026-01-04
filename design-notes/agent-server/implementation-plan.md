# Cast Backend Implementation Plan

Blueprint for reimplementing the Cast backend based on the spec suite. Prioritizes containerized agent infrastructure as the core value, then builds collaboration features on top.

---

## Scoping Decisions

Decisions captured from spec review discussion:

| Area | Decision | Notes |
|------|----------|-------|
| **Agent Engines** | `claude-code` (sandbox) priority | Containerized agents are core value |
| **Storage Backend** | PlanetScale | Implementation choice; spec defines semantics only |
| **Auth - Users** | Mock (dev) + WorkOS (prod) | Replacing Sanity OAuth |
| **Auth - Agents** | Container tokens | As spec'd in [[agent-auth-spec]] |
| **KB/Semantic Search** | In scope, phased | After core artifact CRUD |
| **WebSocket Container Tokens** | Deferred | Agents use HTTP POST, not WS subscription |
| **Package Structure** | Consolidate | Implementation team's discretion |

---

## Technical Debt Treatment

From [[technical-debt]], prioritized for this implementation:

### Address in Implementation (Blockers)

| # | Item | Phase | Rationale |
|---|------|-------|-----------|
| 1 | ParticipantType mismatch | Phase 2 | Define once in core types |
| 2 | ParticipantStatus mismatch | Phase 2 | Define once in core types |
| 3 | SSE transport schema vs runtime | Phase 1 | Fix in MCP config validation |
| 4 | Root channel fallback duplication | Phase 3 | Single helper function |

### Defer to V2

| # | Item | Rationale |
|---|------|-----------|
| 5 | Roster entry update API | Not critical path |
| 6 | No hard delete | Soft delete sufficient for MVP |
| 7 | No bulk operations | Single-item ops work for MVP |
| 8 | Path staleness on parent move | Edge case, manual workaround exists |
| 9 | turnId underutilization | Positional grouping works |
| 10 | No message retry mechanism | Handle at application layer initially |
| 11 | WebSocket container token auth | Agents use HTTP, not WS subscribers |

---

## Package Structure (Proposed)

Consolidating from 7+ packages to 4:

```
packages/
├── core/           # Types, Tymbal protocol, utilities
├── server/         # HTTP API, WebSocket, agent manager (absorbs handlers)
├── storage/        # Storage interface + PlanetScale implementation
└── runtime/        # Docker orchestration (absorbs local-runtime)
```

**Rationale:**
- `handlers` → `server`: Business logic lives with HTTP layer
- `local-runtime` + `fargate-runtime` → `runtime`: Single orchestration package
- `mcp` → `server`: MCP HTTP transport is part of server
- `web` → Separate repo or later phase

---

## Phase 1: Agent Core

**Goal:** Containerized agents can spawn, execute, and communicate with backend.

### Deliverables

1. **Docker Orchestrator**
   - Container lifecycle (create, start, stop, remove)
   - Environment injection (CIKADA_AUTH_TOKEN, CIKADA_API_URL, etc.)
   - Workspace volume management
   - Health checks and cleanup

2. **Container Token Auth**
   - Token generation: `base64url(spaceId:channelId:callsign).hmac`
   - Token verification middleware
   - `X-Cikada-Token` header handling
   - Secret management (env var, dev fallback)

3. **Tymbal Frame Handler**
   - Frame parsing (Start, Append, Set, Reset)
   - Field normalization (`input` → `args`)
   - Broadcast to WebSocket clients
   - Persist SetFrames to storage
   - Route @mentions to target agents

4. **Agent Manager (Core)**
   - `spawnAgent()` - resolve definition, create container, generate token
   - `sendToAgent()` - deliver message to running agent
   - `routeMessage()` - parse @mentions, determine targets, spawn if needed
   - Agent state tracking (idle, thinking, etc.)

### Dependencies
- None (foundation layer)

### Storage Requirements
- Messages table (for Tymbal frame persistence)
- Basic channel/roster lookup (can be minimal)

### Exit Criteria
- Can spawn a claude-code container
- Container can POST Tymbal frames to server
- Server broadcasts frames to WebSocket clients
- Server persists SetFrames
- @mention routing triggers agent spawn and message delivery

---

## Phase 2: Channel Foundation

**Goal:** Full channel and roster management with message history.

### Deliverables

1. **Channel CRUD**
   - Create channel (with focus area resolution)
   - Get channel with roster
   - List channels
   - Archive channel

2. **Roster Management**
   - Add/remove participants (users and agents)
   - Agent spawning from roster (resolve definition, MCP config)
   - Leader designation
   - Status tracking

3. **Message Storage**
   - Full StoredMessage schema
   - `addressedAgents` for routing history
   - Query by channel, pagination (since/before/limit)
   - Agent-scoped history (messages since joinedAt)

4. **WebSocket Streaming**
   - Connection management per channel
   - Sync request handling (replay history)
   - Real-time frame broadcast
   - Session-based auth (users only)

5. **Focus Areas**
   - `system.focus` artifact resolution
   - Default agent spawning on channel create
   - Tagline/mission defaults

### Dependencies
- Phase 1 (agent core must work)

### Type Definitions (Addressing Debt #1-2)
```typescript
// Canonical definitions in @cast/core
type ParticipantType = 'user' | 'agent';
type ParticipantStatus = 'online' | 'offline' | 'busy' | 'idle';
```

### Exit Criteria
- Can create channel with focus area
- Agents auto-spawn per focus config
- Full message history with scoping
- WebSocket sync and streaming works
- Roster add/remove with broadcasts

---

## Phase 3: Artifacts & Board

**Goal:** Persistent collaboration artifacts with versioning and MCP access.

### Deliverables

1. **Artifact CRUD**
   - Create with slug uniqueness
   - Read with version list
   - List with filters (type, status, assignee, search)
   - Glob tree view
   - Archive (soft delete)

2. **Tree Hierarchy**
   - `parentSlug` relationships
   - Path computation
   - Tree formatting for glob output

3. **System Artifact Types**
   - `system.agent` - agent definitions with props validation
   - `system.mcp` - MCP server config with props validation
   - `system.focus` - channel templates
   - `system.playbook` - workflow guidelines

4. **CAS Updates**
   - Compare-and-swap for safe concurrent updates
   - Conflict detection and reporting
   - Atomic multi-field changes

5. **Versioning**
   - Optimistic concurrency (version counter)
   - Named checkpoints (snapshots)
   - Version retrieval and listing

6. **MCP Tool Interface**
   - HTTP transport at `/mcp/:channelId/tools/*`
   - artifact_create, read, list, glob, update, edit, archive
   - message_get, message_search
   - `[[slug]]` reference extraction

7. **Resolution Patterns** (Addressing Debt #4)
   - Single `resolveSystemArtifact()` helper
   - Channel-local → root fallback
   - Used by agent resolution, MCP config lookup

### Dependencies
- Phase 2 (channels and roster must exist)

### Props Schema Validation (Addressing Debt #3)
```typescript
// Fix: Add 'sse' to transport validation
transport: z.enum(['stdio', 'http', 'sse'])
```

### Exit Criteria
- Full artifact CRUD with tree hierarchy
- CAS updates prevent race conditions
- Checkpoints create immutable snapshots
- MCP tools work from agent containers
- System artifacts resolve with fallback

---

## Phase 4: KB, Auth & Polish

**Goal:** Knowledge base, production auth, and remaining features.

### Deliverables

1. **Knowledge Base**
   - KB document indexing
   - Tree navigation
   - Keyword search (FTS)
   - Semantic search (embeddings) - if PlanetScale supports or external service

2. **WorkOS OAuth**
   - OAuth flow implementation
   - Session management
   - User identity resolution
   - Space/tenant association

3. **Structured Asks**
   - Form definition schema
   - Submit handling
   - Response routing to agents

4. **Assets & Attachments**
   - Binary upload/download
   - Message attachment linking

5. **Artifact WebSocket Events**
   - Broadcast artifact mutations
   - Real-time board updates

### Dependencies
- Phase 3 (artifacts must be complete)

### Exit Criteria
- KB search works (keyword at minimum)
- WorkOS login flow complete
- Structured asks render and submit
- File attachments work
- Real-time artifact updates broadcast

---

## Cross-Cutting Concerns

### Error Handling
- Consistent error response format: `{ error: string }`
- HTTP status codes per spec
- WebSocket close codes (4000, 4001, 4003)

### Observability
- Request logging
- Agent lifecycle events
- Error tracking

### Testing Strategy
- Unit tests for core logic (Tymbal parsing, token verification)
- Integration tests for API endpoints
- E2E tests for agent spawn → message → response flow

### Configuration
- Environment-based config
- Dev/prod mode switching
- Secret management for container tokens and OAuth

---

## Open Questions

1. **Fargate Support**: Is AWS Fargate in scope, or Docker-only for now?
2. **Multi-tenancy**: How are spaces/tenants provisioned? Manual or self-service?
3. **Rate Limiting**: Any requirements for API rate limiting?
4. **Monitoring**: Specific observability requirements (metrics, tracing)?

---

## References

- [[cast-backend-spec]] — Entry point to spec suite
- [[architecture-overview]] — System diagrams
- [[agent-auth-spec]] — Container token details
- [[tymbal-spec]] — Streaming protocol
- [[channels-spec]] — Channel/roster details
- [[artifacts-data-model]] — Artifact schema
- [[technical-debt]] — Known issues

