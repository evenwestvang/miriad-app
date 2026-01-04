# Refactor Plan: cikada-redux → Cast Backend

Based on analysis of both codebases, we'll refactor **cikada-redux** as the foundation, incorporating select patterns from **powpow**.

---

## Codebase Comparison

| Aspect | powpow (~31K LOC) | cikada-redux (~48K LOC) |
|--------|-------------------|------------------------|
| **Storage** | SQLite only (better-sqlite3) | Storage interface + SQLite/DynamoDB backends |
| **Architecture** | Monolithic server (all in src/server/index.ts) | Modular packages (@cikada/core, @cikada/handlers, @cikada/storage, @cikada/server) |
| **Multi-tenancy** | Single-tenant (no spaceId) | Multi-tenant ready (spaceId in all interfaces) |
| **Agent Protocol** | MCP over HTTP + SSE | Tymbal NDJSON streaming |
| **Agent Provider** | CodingAgentProvider abstraction (claude/codex/external) | AgentManager with container orchestration |
| **HTTP Server** | Raw Node.js http module | Node.js http + separate HTTP handler module |
| **WebSocket** | SSE-only for real-time | True WebSocket for streaming |

---

## Decision: Start from cikada-redux

For a system targeting **tens of thousands of concurrent agents in thousands of channels**, cikada-redux is the better foundation.

### Why cikada-redux:

1. **Multi-tenant from day one** — `spaceId` is already threaded through every interface. powpow would need this retrofitted everywhere.

2. **Clean storage abstraction** — The `Storage` interface is production-ready with SQLite/DynamoDB implementations. Swapping PlanetScale is straightforward.

3. **Proper separation of concerns** — Business logic lives in @cikada/handlers (framework-agnostic), adapters in @cikada/server. This matches the thin-adapter pattern.

4. **Tymbal protocol** — NDJSON streaming is more efficient for high-volume agent traffic than MCP-over-HTTP.

5. **WebSocket** — Real WebSocket for streaming is better for scale than SSE.

6. **Container orchestration** — Already has Docker/Fargate abstractions in `packages/fargate-runtime/`.

### What we'll port from powpow:

1. **OAuth for MCPs** — Comprehensive MCP auth flow in `src/server/oauth/`.

2. **Mature artifact tooling** — 44K lines of artifact tooling refinements.

3. **External MCP resolution** — Patterns for resolving MCP configs with OAuth tokens.

---

## Agent Architecture

Two supported agent types (no naked SDK agents):

### 1. Container Agents (claude-code, sandbox)

- SDK runs **inside** Docker container
- Full isolation, resource limits
- Persistent workspace (volume mounts)
- Communicates via Tymbal frames over HTTP
- For long-running coding tasks

### 2. Lambda Stateless Agents (reactive)

- SDK runs in Lambda function
- No persistence between invocations
- Event-driven (triggered by @mention)
- For quick responses, event handlers
- Cheaper at scale for bursty workloads

**Why no naked agents:**

Running agents "naked" on the host (like powpow) works for single-user dev, but is irresponsible for multi-tenant:
- Agents can kill each other's processes
- Filesystem collisions
- Resource contention
- Security boundary violations
- One `rm -rf /` away from disaster

Container isolation is non-negotiable for multi-tenant safety.

---

## Package Structure (Target)

```
packages/
├── core/           # Types, Tymbal protocol, utilities
│   ├── types/      # Channel, Message, Artifact, etc.
│   ├── tymbal/     # Frame parsing, building
│   └── utils/      # ULID, validation helpers
│
├── handlers/       # Framework-agnostic business logic
│   ├── agents/     # Agent resolution, spawn logic
│   ├── artifacts/  # Artifact CRUD, CAS, versioning
│   ├── channels/   # Channel CRUD, roster
│   └── bootstrap/  # Seeding, initialization
│
├── storage/        # Storage interface + implementations
│   ├── interface.ts
│   ├── planetscale.ts
│   └── sqlite.ts   # For local dev
│
├── server/         # Hono HTTP + WebSocket + Agent Manager
│   ├── handlers/   # Route handlers
│   ├── adapters/   # Hono routes, Lambda handlers
│   ├── websocket/  # Connection management
│   └── agent/      # Agent lifecycle, routing
│
└── runtime/        # Container orchestration
    ├── interface.ts
    ├── docker.ts   # Local dev
    └── fargate.ts  # AWS prod
```

---

## Phase 1: Agent Core

**Goal:** Containerized agents can spawn, execute, and communicate with backend.

**Why first:** Containerized agents are the core value proposition. Without this working, nothing else matters. This phase proves the fundamental architecture.

### Tasks

#### 1.1 Docker Orchestrator
- Container lifecycle management (create, start, stop, remove)
- Environment variable injection (API keys, container token)
- Volume mounts for workspace persistence
- Resource limits (memory, CPU)
- Health checks and restart policies

**Source:** Adapt from `cikada-redux/packages/fargate-runtime/`

#### 1.2 Container Token Auth
- Token generation: `base64url(spaceId:channelId:callsign).hmac`
- Token verification middleware
- Token injection into container env
- Expiry and rotation strategy

**Source:** Implement per `agent-auth-spec`

#### 1.3 Tymbal Frame Handler
- Frame parsing (Start, Append, Set, Reset)
- Frame validation and error handling
- Broadcast to WebSocket clients
- Persist SetFrames to storage
- Extract @mentions for routing

**Source:** Adapt from `cikada-redux/packages/core/src/tymbal/`

#### 1.4 Agent Manager Core
- `spawn(spaceId, channelId, agentConfig)` → AgentHandle
- `sendToAgent(handle, message)` → void
- `routeMessage(spaceId, channelId, sender, content)` → void
- `kick(handle)` → void
- Agent state tracking (starting, running, idle, stopped, error)

**Source:** Adapt from `cikada-redux/packages/server/src/agent-manager.ts`

#### 1.5 Minimal Storage
- Messages table (id, channelId, sender, content, timestamp, addressedAgents)
- Storage interface for messages only
- SQLite implementation for local dev

**Source:** Subset of `cikada-redux/packages/storage/`

#### 1.6 HTTP Endpoint for Tymbal
- `POST /tymbal` - receive frames from containers
- Container token auth middleware
- Frame routing to handler
- Error responses

**Source:** Implement per `client-api-reference`

### Exit Criteria
- Spawn a claude-code container
- Container POSTs Tymbal frames to server
- Server broadcasts to WebSocket clients
- Server persists SetFrames
- @mention routing triggers agent spawn

### Risks
- Docker orchestration complexity → Start with simplest config, iterate
- Tymbal frame edge cases → Comprehensive test suite

---

## Phase 2: Channel Foundation

**Goal:** Full channel and roster management with message history.

**Why second:** Agents need channels to live in. This phase provides the context for agent collaboration — where agents are, who they talk to, message history.

### Tasks

#### 2.1 Channel CRUD
- `createChannel(spaceId, name, focusSlug?, metadata)`
- `getChannel(spaceId, channelId)`
- `listChannels(spaceId, includeArchived?)`
- `archiveChannel(spaceId, channelId)`
- Focus resolution from system.focus artifacts

**Source:** Adapt from `cikada-redux/packages/handlers/src/channels/`

#### 2.2 Roster Management
- `addToRoster(spaceId, channelId, entry)`
- `removeFromRoster(spaceId, channelId, participantId)`
- `getRoster(spaceId, channelId)`
- `updateRosterEntry(spaceId, channelId, participantId, update)`
- Leader designation for unaddressed messages
- Status tracking (idle, thinking, tool_running)

**Source:** Adapt from `cikada-redux/packages/storage/src/interface.ts`

#### 2.3 Message Storage (Full Schema)
- Full message schema per spec (id, channelId, sender, content, timestamp, addressedAgents, complete, attachmentIds)
- Pagination (before, since, limit)
- Agent-scoped history (getAgentHistory with sinceTimestamp)
- addressedAgents extraction from @mentions

**Source:** Adapt from `cikada-redux/packages/storage/`

#### 2.4 WebSocket Streaming
- Connection management (connect, disconnect, reconnect)
- Sync endpoint (`GET /channels/:id/sync?since=`)
- Real-time broadcast of new messages
- Roster change events
- Agent state change events

**Source:** Adapt from `cikada-redux/packages/server/src/websocket.ts`

#### 2.5 Focus Areas
- system.focus artifact type with props (agents[], defaultTagline, defaultMission)
- Focus resolution on channel creation
- Auto-spawn agents per focus config
- Focus content injection into channel specialInstructions

**Source:** Per `channels-spec` and `resolution-patterns`

### Exit Criteria
- Create channel with focus area
- Agents auto-spawn per focus config
- Full message history with scoping
- WebSocket sync and streaming works
- Roster changes broadcast correctly

### Dependencies
- Phase 1 complete (agent core must work)

### Risks
- Message routing complexity with @mentions → Clear routing rules, test coverage
- WebSocket reconnection edge cases → Robust sync mechanism

---

## Phase 3: Artifacts & Board

**Goal:** Persistent collaboration artifacts with versioning and MCP access.

**Why third:** Artifacts are the persistent work products — specs, tasks, decisions. Agents need MCP tools to interact with artifacts. This is where collaboration becomes durable.

### Tasks

#### 3.1 Artifact CRUD
- `createArtifact(spaceId, channelId, input)`
- `getArtifact(spaceId, channelId, slug)`
- `updateArtifact(spaceId, channelId, slug, update, updatedBy)`
- `archiveArtifact(spaceId, channelId, slug, updatedBy)`
- `listArtifacts(spaceId, channelId, filters)`
- Auto-extract refs from `[[slug]]` syntax

**Source:** Adapt from `cikada-redux/packages/storage/src/interface.ts`

#### 3.2 Tree Hierarchy
- parentSlug field for nesting
- Path computation (/parent/child/grandchild)
- `globArtifacts(pattern)` for tree queries
- orderKey for sibling ordering (fractional indexing)

**Source:** Per `artifacts-data-model`

#### 3.3 System Artifact Types
- system.agent props validation (engine, model, nameTheme, mcp[])
- system.mcp props validation (transport, command/url, env, auth)
- system.focus props validation (agents[], defaultTagline, defaultMission)
- system.playbook (no special props, just content)
- Props schema validation on create/update

**Source:** Per `artifacts-data-model` and `resolution-patterns`

#### 3.4 CAS Updates
- `updateArtifactWithCAS(spaceId, channelId, slug, changes[], updatedBy)`
- Compare old_value against current before applying
- Return conflict info on mismatch
- Atomic multi-field updates

**Source:** Per `artifacts-api-spec`

#### 3.5 Versioning
- Optimistic concurrency (version field, increment on update)
- `checkpointArtifact(slug, versionName, message)`
- `getArtifactVersion(slug, versionName)`
- `listArtifactVersions(slug)`
- Immutable version snapshots

**Source:** Per `artifacts-storage-versioning`

#### 3.6 MCP Tool Interface
- HTTP transport for MCP (`POST /mcp`)
- Artifact tools (glob, read, create, edit, update, list, archive, checkpoint, diff)
- Message tools (list_channels, track_channel, send_message, get_messages, set_status)
- KB tools (kb_list, kb_glob, kb_read, kb_query)
- Tool registration and routing

**Source:** Per `artifacts-api-spec`, port patterns from `powpow/src/server/artifact-tools.ts`

#### 3.7 Resolution Patterns
- Channel-local artifact lookup
- Fallback to #root channel
- `getArtifactWithFallback(channelId, slug)`
- `resolveAgentDefinition(channelId, agentSlug)`
- `resolveMcpConfig(channelId, mcpSlug)`

**Source:** Per `resolution-patterns`

### Exit Criteria
- Full artifact CRUD with tree hierarchy
- CAS prevents race conditions
- Checkpoints create immutable snapshots
- MCP tools work from agent containers
- System artifacts resolve with fallback

### Dependencies
- Phase 2 complete (channels and roster must exist)

### Risks
- CAS complexity → Implement basic update first, layer CAS
- MCP tool surface area → Start with core tools, expand iteratively

---

## Phase 4: KB, Auth & Polish

**Goal:** Knowledge base, production auth, and remaining features.

**Why last:** These are important but not foundational. KB enhances artifact utility. WorkOS enables production deployment. Structured asks and attachments round out the feature set.

### Tasks

#### 4.1 Knowledge Base
- KB artifact type (knowledgebase) with indexing
- Tree navigation (kb_glob)
- Document retrieval (kb_read)
- FTS5 keyword search (kb_query with mode: keyword)
- Semantic search with embeddings (kb_query with mode: semantic) - optional
- Embedding storage and similarity search

**Source:** Adapt from `cikada-redux/packages/server/src/embeddings.ts`, port patterns from `powpow/src/server/kb-tools.ts`

#### 4.2 WorkOS OAuth
- OAuth 2.0 authorization flow
- Token exchange and refresh
- Session management (JWT or opaque tokens)
- Space association (user → space mapping)
- Logout and session invalidation

**Source:** Replace Sanity OAuth in cikada-redux with WorkOS per `agent-auth-spec`

#### 4.3 Structured Asks
- StructuredAskFormData schema (prompt, fields[], submitLabel, to[])
- Field types (radio, checkbox, text, textarea, select, summon_request)
- `saveStructuredAsk(spaceId, params)`
- `submitStructuredAskResponse(spaceId, params)`
- Response routing back to requesting agent

**Source:** Adapt from `cikada-redux/packages/storage/src/interface.ts`

#### 4.4 Assets & Attachments
- Binary upload endpoint (`POST /channels/:id/upload`)
- Attachment metadata storage
- Message linking (attachmentIds[])
- Download endpoint (`GET /attachments/:id`)
- File size limits and validation

**Source:** Per `client-api-reference`

#### 4.5 Artifact WebSocket Events
- Real-time artifact create/update/archive events
- Version checkpoint events
- Board subscription per channel
- Efficient delta updates

**Source:** Enhance WebSocket from Phase 2

#### 4.6 Lambda Stateless Agents
- Lambda handler for reactive agents
- Stateless agent configuration (system.agent with engine: reactive)
- Event-driven invocation (on @mention)
- Response via Tymbal frames

**Source:** New implementation per spec

### Exit Criteria
- KB search works (keyword at minimum, semantic if feasible)
- WorkOS login flow complete
- Structured asks render and submit
- File attachments work
- Real-time artifact updates broadcast
- Lambda agents respond to mentions

### Dependencies
- Phase 3 complete (artifacts must be complete)

### Risks
- Semantic search requires embeddings API → Make optional, keyword baseline
- WorkOS integration complexity → Follow their SDK docs closely
- Lambda cold starts → Optimize handler size, consider provisioned concurrency

---

## Phase Dependencies

```
Phase 1: Agent Core
    │
    │  Agents can spawn and communicate
    │
    ▼
Phase 2: Channel Foundation
    │
    │  Agents have context (channels, roster, history)
    │
    ▼
Phase 3: Artifacts & Board
    │
    │  Agents can create/read persistent work products
    │
    ▼
Phase 4: KB, Auth & Polish
    │
    │  Production-ready with search and auth
    │
    ▼
  Done
```

---

## Recommendations

1. **Get Phase 1 working end-to-end before parallelizing.** The learning from Phase 1 informs everything else.

2. **Within phases, parallelize where possible.** Phase 1's Docker orchestrator is independent of token auth. Phase 2's roster is independent of WebSocket.

3. **Start with SQLite locally, add PlanetScale after Phase 2.** Validate the storage interface before adding another backend.

4. **Port powpow's artifact tooling incrementally in Phase 3.** Don't try to bring it all at once.

5. **Lambda agents are Phase 4 scope.** Container agents are the priority — they're harder and more valuable.
