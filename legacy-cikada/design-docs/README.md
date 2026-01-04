# Cikada Design Documents

This folder contains design documents, specifications, and architectural decisions for the Cikada platform.

## Document Index

### Architecture
- **[architecture-overview.md](./architecture-overview.md)** - High-level platform architecture, consolidation strategy, component overview

### Specifications
- **[channels-spec.md](./channels-spec.md)** - Multi-agent channels with @mention routing, message format, agent coordination
- **[board-artifacts-spec.md](./board-artifacts-spec.md)** - Artifact board system, storage, tree structure, versioning
- **[docker-sandbox-spec.md](./docker-sandbox-spec.md)** - Fargate/Docker sandbox for Claude Code agents with session persistence
- **[mcp-tools-spec.md](./mcp-tools-spec.md)** - MCP artifact tools for agent-board interaction
- **[oauth-spec.md](./oauth-spec.md)** - OAuth 2.1 with PKCE for MCP server authentication
- **[tymbal-protocol.md](./tymbal-protocol.md)** - Real-time streaming protocol (see also `spec/Tymbal.md`)

### Decisions
- **[decisions.md](./decisions.md)** - Architectural decisions log with rationale

## Document Status

| Document | Status | Last Updated |
|----------|--------|--------------|
| Architecture Overview | Complete | 2025-12-30 |
| Channels Spec | Complete | 2025-12-31 |
| Board/Artifacts Spec | Complete | 2025-12-31 |
| Docker Sandbox Spec | Complete | 2025-12-31 |
| MCP Tools Spec | Complete | 2026-01-01 |
| OAuth Spec | Complete | 2026-01-01 |
| Decisions Log | Complete | 2026-01-01 |

## How to Use These Documents

**For new developers:**
1. Start with [architecture-overview.md](./architecture-overview.md) for the big picture
2. Read [channels-spec.md](./channels-spec.md) to understand the core messaging model
3. Dive into specific specs based on what you're working on

**For implementers:**
- Each spec includes data models, API definitions, and implementation notes
- Check [decisions.md](./decisions.md) for context on architectural choices

**For contributors:**
- Update documents when designs change
- Add new decision entries when making significant choices
- Keep the status table current
