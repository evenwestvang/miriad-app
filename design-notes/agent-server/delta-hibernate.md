# Delta Hibernate Context

Full context dump for resuming work on the Cast backend implementation.

---

## My Role

I'm **@delta**, a Builder agent in the #cast-backend-spec channel. I was brought in to lead the implementation team for the Cast agent collaboration platform.

## Team

- **@simen** — Human project owner
- **@lead** — Lead agent, coordinates the spec work
- **@alfa, @bravo, @charlie** — Fellow Builder agents
- **@ruby** — Reviewer agent

---

## Project Overview

**Cast** is a multi-tenant agent collaboration platform targeting:
- Tens of thousands of concurrent coding agents
- Thousands of channels
- Container-isolated agents (no naked SDK agents)

The platform enables AI agents to collaborate on software engineering tasks via channels, with persistent artifacts (specs, tasks, decisions, code) on a shared board.

---

## Key Decisions Made

### 1. Storage Backend
- **Decision:** PlanetScale (MySQL-compatible)
- **Rationale:** Production-ready, scales well, team familiar with it
- **Note:** SQLite for local dev, storage interface allows swapping

### 2. Authentication
- **Dev:** Mock auth (direct login bypass)
- **Prod:** WorkOS OAuth (replacing Sanity OAuth from original cikada-redux)
- **Agents:** Container tokens (`base64url(spaceId:channelId:callsign).hmac`)

### 3. Agent Types
- **Container agents** (claude-code, sandbox) — SDK inside Docker, full isolation
- **Lambda stateless agents** (reactive) — For quick responses, event handlers
- **NO naked SDK agents** — Isolation mandatory for multi-tenant safety

### 4. Base Codebase
- **Decision:** Refactor cikada-redux (not powpow)
- **Rationale:**
  - Multi-tenant (spaceId throughout)
  - Clean storage abstraction
  - Modular package structure
  - Tymbal protocol for streaming
  - Container orchestration in place

### 5. What to Port from powpow
- OAuth patterns for MCP servers (`src/server/oauth/`)
- Mature artifact tooling refinements
- External MCP resolution patterns

---

## Spec Suite Location

All specs exported to: `/Users/simen/dev/cast-redux/specifications/agent-server/`

Key files:
- `cast-backend-spec.md` — Overview
- `architecture-overview.md` — System diagrams
- `channels-spec.md` — Channels, rosters, agents
- `artifacts-data-model.md` — Artifact schema
- `agent-communication-spec.md` — Message routing, Tymbal
- `tymbal-spec.md` — Streaming protocol
- `client-api-reference.md` — HTTP/WebSocket API
- `agent-auth-spec.md` — Container token auth
- `artifacts-api-spec.md` — HTTP/MCP API for artifacts
- `artifacts-storage-versioning.md` — SQLite, versioning
- `resolution-patterns.md` — Cross-cutting patterns
- `technical-debt.md` — 11 cleanup items
- `implementation-notes.md` — My implementation guidance (Hono, thin adapter pattern, phasing)
- `refactor-plan.md` — Detailed task breakdown for refactor

---

## Codebases Analyzed

### cikada-redux (~48K LOC)
Location: `/private/tmp/powpow/cast-backend-spec--delta/cikada-redux`
(Also at `github.com/simen/cikada-redux`)

**Structure:**
```
packages/
├── core/           # Types, Tymbal protocol
├── handlers/       # Framework-agnostic business logic
├── storage/        # Storage interface + SQLite/DynamoDB
├── server/         # HTTP + WebSocket + AgentManager
├── fargate-runtime/# Container orchestration
├── local-runtime/  # Local dev runtime
├── aws-runtime/    # Lambda handlers
├── agent/          # Agent types
├── reactive-agent/ # Reactive agent impl
├── mcp/            # MCP tools
├── test-harness/   # Testing utilities
└── web/            # Frontend
```

**Key files:**
- `packages/storage/src/interface.ts` — Clean storage abstraction (608 lines)
- `packages/server/src/index.ts` — Server factory
- `packages/server/src/agent-manager.ts` — Agent lifecycle
- `packages/core/src/tymbal/` — Tymbal frame handling

### powpow (~31K LOC)
Location: `/private/tmp/powpow/cast-backend-spec--delta/powpow`
(Also at `github.com/sanity-io/powpow`)

**Structure:**
```
src/
├── server/
│   ├── index.ts          # Monolithic server (75K)
│   ├── store.ts          # SQLite store (92K)
│   ├── agent-manager.ts  # Agent lifecycle
│   ├── agent-provider.ts # Provider interface
│   ├── agent-registry.ts # Engine registry
│   ├── artifact-tools.ts # MCP artifact tools (44K)
│   ├── kb-tools.ts       # KB search tools
│   ├── oauth/            # MCP OAuth patterns
│   └── codex-sdk/        # Codex integration
└── shared/
    └── types.ts          # Shared types
```

**Key files:**
- `src/server/agent-provider.ts` — Clean provider interface (335 lines)
- `src/server/store.ts` — SQLite with migrations
- `src/server/oauth/` — MCP OAuth flow

---

## Implementation Phasing

### Phase 1: Agent Core
- Docker orchestrator
- Container token auth
- Tymbal frame handler
- Agent manager core
- Minimal storage (messages only)
- HTTP endpoint for Tymbal

**Exit criteria:** Spawn container → POST frames → broadcast → persist

### Phase 2: Channel Foundation
- Channel CRUD with focus resolution
- Roster management
- Full message storage
- WebSocket streaming
- Focus areas (auto-spawn agents)

**Exit criteria:** Create channel → agents spawn → messages route → WebSocket works

### Phase 3: Artifacts & Board
- Artifact CRUD with tree hierarchy
- System artifact types (system.agent, system.mcp, system.focus)
- CAS updates
- Versioning with checkpoints
- MCP tool interface
- Resolution patterns (channel → root fallback)

**Exit criteria:** Full CRUD → CAS works → MCP tools work from containers

### Phase 4: KB, Auth & Polish
- Knowledge base (FTS + optional semantic)
- WorkOS OAuth
- Structured asks
- Assets & attachments
- Artifact WebSocket events
- Lambda stateless agents

**Exit criteria:** KB search → auth works → attachments work → Lambda agents respond

---

## Technical Concepts

### Tymbal Protocol
NDJSON streaming protocol for agent communication:
- **Start** — Begin new content block
- **Append** — Add to current block (streaming)
- **Set** — Complete block with final content
- **Reset** — Clear and restart

Frame format: `{"t":"set","k":"msg:123","c":"Hello world"}`

### Container Token Auth
Format: `base64url(spaceId:channelId:callsign).hmac`

- Generated when spawning agent
- Injected as `CONTAINER_TOKEN` env var
- Verified on every Tymbal POST
- HMAC uses server's `CONTAINER_SECRET`

### CAS (Compare-and-Swap)
Atomic artifact updates:
```typescript
updateArtifactWithCAS(slug, [
  { field: "status", old_value: "pending", new_value: "in_progress" },
  { field: "assignees", old_value: [], new_value: ["delta"] }
])
```
Returns conflict info if old_value doesn't match current.

### Resolution Patterns
1. Look up artifact in current channel
2. If not found, fall back to #root channel
3. Used for system.agent, system.mcp, system.focus

### Agent Engines
- **claude-code** — Container with Claude SDK, persistent workspace
- **sandbox** — Container for untrusted code execution
- **reactive** — Lambda stateless, event-driven

---

## Files I Created

1. `/Users/simen/dev/cast-redux/specifications/agent-server/implementation-notes.md`
   - Thin adapter pattern architecture
   - Hono framework recommendation
   - Storage abstraction guidance
   - Container orchestration interface
   - Package structure recommendation
   - Local dev experience
   - Deployment strategy
   - Testing strategy
   - 4-phase implementation breakdown

2. `/Users/simen/dev/cast-redux/specifications/agent-server/refactor-plan.md`
   - Codebase comparison (powpow vs cikada-redux)
   - Decision rationale
   - Agent architecture (container + lambda, no naked)
   - Target package structure
   - Detailed task breakdown per phase

3. Board artifacts (in channel, for reference only):
   - `[[implementation-plan]]` — Original implementation plan
   - `[[refactor-plan]]` — Summary (detailed version in file)
   - `[[phase-1-tasks]]`, `[[phase-2-tasks]]`, `[[phase-3-tasks]]`, `[[phase-4-tasks]]`

---

## Open Questions / Future Decisions

1. **PlanetScale schema design** — Need to map storage interface to MySQL tables
2. **Fargate vs ECS for containers** — May depend on cost/scale tradeoffs
3. **MCP OAuth token storage** — Where to persist OAuth tokens for MCP servers
4. **Embedding provider** — OpenAI or alternative for semantic search
5. **WebSocket at scale** — May need API Gateway WebSocket for Lambda path

---

## Quick Reference Commands

```bash
# Spec folder
cd /Users/simen/dev/cast-redux/specifications/agent-server

# cikada-redux codebase
cd /private/tmp/powpow/cast-backend-spec--delta/cikada-redux

# powpow codebase
cd /private/tmp/powpow/cast-backend-spec--delta/powpow
```

---

## To Resume

1. Read this file to restore context
2. Check #cast-backend-spec channel for any new messages
3. Review `refactor-plan.md` for current task breakdown
4. Phase 1 is next — start with Docker orchestrator or container token auth
5. Coordinate with team (@alfa, @bravo, @charlie) for parallel work within phases

---

*Last updated: 2026-01-04T22:03Z by @delta*
