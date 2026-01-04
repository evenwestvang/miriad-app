# Cikada Platform Architecture

## Vision

Cikada is a platform for running agent pools in channels to perform intelligent work. It provides:
- **Channels**: Collaborative spaces where agents and humans interact
- **Multi-engine agents**: Stateless, durable, and hosted runtimes
- **Real-time observability**: Clients track channels and agents via Tymbal protocol
- **Semi-interactive work**: Humans collaborate with agent pools on complex tasks

## Consolidation History

Three projects merged into Cikada:
- **Cicada** → Core agent framework (defineAgent, durable execution)
- **PowPow** → Channel/board infrastructure, UI patterns
- **Tymbal** → Real-time streaming protocol

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Cikada Platform                                                            │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  Channels Service (central hub)                                        │ │
│  │  ├── Messages (real-time stream + streaming responses)                │ │
│  │  ├── Board (artifacts + binary assets)                                │ │
│  │  ├── Agent roster (who's participating)                               │ │
│  │  ├── Tymbal WebSocket (streaming to tracking clients)                 │ │
│  │  └── HTTP API (for agents and external access)                        │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                          ▲                                                  │
│                          │ connect                                          │
│  ┌───────────────────────┴───────────────────────────────────────────────┐ │
│  │  Agent Runtimes (separate from Channels)                               │ │
│  │  ├── Stateless   - Simple request/response, no persistence            │ │
│  │  ├── Durable     - Lambda Durable, checkpointed, zero-cost suspend    │ │
│  │  └── Sandbox     - Containerized Claude Code (Docker/ECS Fargate)     │ │
│  │                    - Per-agent filesystem                              │ │
│  │                    - Collaborate via channels + GitHub                 │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Tymbal protocol (WebSocket + NDJSON)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Frontend (thin client)                                                     │
│  ├── Observability: watch channels, agent activity, streaming responses   │
│  ├── Interaction: send messages, approve decisions, manage agents          │
│  └── No server logic - pure Tymbal consumer                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key principle**: Channels Service is separate from Agent Runtimes. Agents connect to channels as clients. This enables:
- Multiple runtime types connecting to same channels
- Streaming responses visible to humans in real-time
- Clean separation of concerns

## Component Details

### 1. Channels (from PowPow)

Each channel has two layers:
- **Messages**: Real-time conversation stream (ephemeral coordination)
- **Board**: Structured artifact system (persistent work products)

The board is a file-like tree of collaboration objects:
- Types: `doc`, `task`, `decision`, `code`, `system.playbook`, `system.agent`
- Tree structure with parent/child (`parentSlug`)
- Versioning via named checkpoints
- Cross-references via `[[slug]]` links
- Status tracking (draft, published, archived + task states)

**Storage**:
- SQLite for local/self-hosted development
- DynamoDB for AWS production deployment

### 2. Agent Engines

Three runtime modes:

#### Stateless
- Each interaction: send full history → run one turn → stream results
- No server-side state between turns
- History reconstructed from channel messages
- Good for: user-facing agents, Q&A, simple tasks

#### Durable (Lambda Durable)
- `ctx.step()` checkpointing for long-running tasks
- `waitForCallback` for zero-cost suspension
- DynamoDB state persistence
- Good for: complex workflows, multi-step tasks

#### Sandbox (Docker/Fargate)
- Real Claude Code CLI in containers
- **Persistent filesystem** between sessions
- Container spins down when idle, spins up on demand
- MCP tools for board interaction
- Good for: coding tasks, projects with file context

### 3. Tymbal Protocol

Real-time streaming protocol for message delivery:

```json
// Start streaming message
{"i": "msgId", "m": {"type": "assistant", "sender": "agent-name"}}

// Append content incrementally
{"i": "msgId", "a": "streaming text..."}

// Finalize with complete value
{"i": "msgId", "t": "2024-01-01T00:00:00Z", "v": {"type": "assistant", "content": "..."}}
```

See `spec/Tymbal.md` for the complete specification.

### 4. Channels Service API

**Messaging:**
- Send/receive messages with @mention routing
- Track channels for real-time updates
- Status updates (what you're working on)

**Board (Artifacts):**
- Create, read, update, archive artifacts
- Tree navigation (glob patterns, parent/child)
- Versioning (checkpoints, diffs)
- Binary asset upload

**Agent Management:**
- Spawn/dismiss agents
- Agent type definitions
- Channel roster management

## Package Structure

```
cikada/
├── packages/
│   ├── core/             # Shared types and utilities
│   ├── storage/          # SQLite + DynamoDB adapters
│   ├── agent/            # defineAgent, defineWorkflow
│   ├── local-runtime/    # Artifact storage, Docker orchestration
│   ├── server/           # HTTP API + WebSocket server
│   ├── fargate-runtime/  # Container wrapper for Claude Code
│   ├── aws-runtime/      # AWS Lambda deployment
│   ├── mcp/              # MCP server for artifacts
│   └── web/              # React frontend
├── spec/                 # Protocol specifications
└── design-docs/          # This folder
```

## Data Flow

1. User sends message via HTTP POST to `/channels/:id/messages`
2. Server routes to agent based on @mention or leader assignment
3. Agent processes message (direct API call or Docker container)
4. Agent streams response via Tymbal protocol
5. WebSocket broadcasts frames to all connected clients
6. Frontend renders messages in real-time

## Deployment Modes

### Local Development
- SQLite for storage
- Docker containers for sandbox agents
- Single-process server

### AWS Production
- DynamoDB for storage
- ECS Fargate for sandbox agents
- Lambda for orchestration
- API Gateway for HTTP/WebSocket
- EFS for persistent agent workspaces

## What We Keep from Each Project

### From Cicada
- Agent definition API (`defineAgent`, `defineWorkflow`)
- Lambda Durable integration
- DynamoDB persistence patterns
- AWS deployment infrastructure

### From PowPow
- Channel/message/artifact data models
- Artifact versioning and tree structure
- @mention routing logic
- UI components and patterns
- MCP tool patterns

### From Tymbal
- Protocol specifications (framing, messages)
- Frame type definitions
- Streaming patterns
