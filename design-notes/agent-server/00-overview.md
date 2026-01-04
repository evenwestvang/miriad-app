# Cast Backend Specification

Technical specification for the Cast backend (cikada-redux), verified against actual code implementation. Use this as the entry point for understanding the system architecture and APIs.

**Repository:** `git clone https://github.com/simen/cikada-redux`

---

## Quick Start for Implementers

1. Read [[architecture-overview]] for visual system diagrams and component relationships
2. Start with [[client-api-reference]] for the full HTTP/WebSocket API surface
3. Read domain specs below for data models and business logic
4. Check [[technical-debt]] for known issues to address in reimplementation
5. Reference [[resolution-patterns]] for cross-cutting lookup behaviors

---

## Domain Specifications

### Channels & Rosters
How channels work, agent definitions, spawning, and roster management.

| Spec | TL;DR |
|------|-------|
| [[channels-spec]] | Channel lifecycle, roster operations, agent spawning flow, focus areas. Covers spaces → channels → roster hierarchy and how agents are resolved/launched. |

**Key concepts:** Spaces, Channels, RosterEntry, FocusType, channel-local → root fallback

---

### Boards & Artifacts  
The persistent collaboration board system for specs, tasks, decisions, and code.

| Spec | TL;DR |
|------|-------|
| [[artifacts-data-model]] | Core Artifact entity with 18 fields, type system (doc/task/code/decision/system.*), status lifecycle, tree hierarchy via parentSlug, validated props schemas. |
| [[artifacts-api-spec]] | HTTP REST API (`/channels/:id/artifacts/*`) and MCP tool interface (`/mcp/:id/tools/*`). CRUD, glob tree view, CAS updates, checkpoints. |
| [[artifacts-storage-versioning]] | SQLite schema, optimistic concurrency, named version snapshots, KB indexing for semantic search, path computation. |

**Key concepts:** Artifact, slug, parentSlug/path tree, CAS updates, checkpoints, system.mcp/agent/focus props

---

### Agent Communication
How messages flow between users, agents, and the system.

| Spec | TL;DR |
|------|-------|
| [[agent-communication-spec]] | Message types, @mention routing, Tymbal streaming protocol, agent history construction, WebSocket lifecycle. |
| [[tymbal-spec]] | Authoritative Tymbal/1.0 protocol spec — frame types (Meta/Append/Set/Delete), NDJSON format, sync mechanism. |

**Key concepts:** StoredMessage, addressedAgents, Tymbal frames, streaming lifecycle, sync protocol

---

## Cross-Cutting Concerns

| Doc | TL;DR |
|-----|-------|
| [[architecture-overview]] | Comprehensive ASCII diagrams: system architecture, message flow, agent execution modes, Tymbal lifecycle, storage layer, package dependencies, deployment topology. |
| [[resolution-patterns]] | Channel-local → root fallback pattern for system artifacts. Used by agent resolution, MCP config lookup. |
| [[technical-debt]] | 11 cleanup items: type inconsistencies, SSE validation gap, path staleness, missing APIs, code duplication, WebSocket container token gap. |
| [[client-api-reference]] | Complete HTTP + WebSocket API reference for frontend developers. Auth, channels, roster, messages, artifacts, KB, streaming. |

---

## Security

| Doc | TL;DR |
|-----|-------|
| [[agent-auth-spec]] | Container token authentication for agents. Token format `base64url(spaceId:channelId:callsign).hmac`, dual auth middleware, scoped to (space, channel, callsign). |

**Key concepts:** Container tokens, X-Cikada-Token header, HMAC verification, DEV_SECRET fallback for local dev

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                               │
│              (Web UI, CLI, External Integrations)            │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP / WebSocket
┌─────────────────────────▼───────────────────────────────────┐
│                    @cikada/server                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   HTTP API  │  │  WebSocket  │  │   MCP HTTP Transport│  │
│  │  (REST)     │  │  (Tymbal)   │  │   (Agent Tools)     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼────────────────────┼─────────────┘
          │                │                    │
┌─────────▼────────────────▼────────────────────▼─────────────┐
│                    @cikada/storage                           │
│         (SQLite local / DynamoDB production)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Channels │  │  Roster  │  │ Messages │  │ Artifacts│     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└─────────────────────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────────┐
│                  @cikada/local-runtime                       │
│              (Docker containers for agents)                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Agent Instance (Claude Code + MCP servers)         │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Package Structure

| Package | Purpose |
|---------|---------|
| `@cikada/server` | HTTP API, WebSocket server, MCP HTTP transport |
| `@cikada/storage` | Storage abstraction (SQLite, DynamoDB) |
| `@cikada/core` | Shared types and utilities |
| `@cikada/handlers` | Business logic handlers (agents, artifacts, channels) |
| `@cikada/mcp` | MCP server configuration resolution |
| `@cikada/local-runtime` | Docker orchestration for local agents |
| `@cikada/web` | React frontend |

---

## Status

✅ **Complete** — All domain specs drafted, reviewed, and fact-checked against code.

### Contributors

| Callsign | Role | Contributions |
|----------|------|---------------|
| @alfa | Builder | Artifacts/boards specs, client API artifacts section |
| @bravo | Builder | Channels/rosters spec, client API reference, agent auth spec |
| @charlie | Builder | Agent communication spec, Tymbal spec |
| @ruby | Reviewer | Code verification across all specs |
| @lead | Coordinator | Project structure, synthesis docs |
