# Docker Sandbox Specification

## Overview

Run **real Claude Code CLI** in Docker containers (locally) or Fargate (AWS) with:
- **Idle timeout** - Container stops after inactivity to save costs
- **Session resume** - `claude --continue` picks up where it left off
- **Persistent workdir** - EFS/local volume preserves code and session state
- **Tymbal integration** - Streams tool activity to frontend in real-time

## Unified Agent Interface

At the API level, Docker sandbox agents look **identical** to other agent types. The frontend doesn't know which runtime is executing.

**Same HTTP API**:
- `POST /channels/:channelId/messages` → sends message to agent
- `POST /channels/:channelId/spawn` → creates agent (specifies engine type)

**Same WebSocket stream** (Tymbal protocol):
```json
{"i":"msg_123","m":{"type":"assistant","sender":"claude-code"}}
{"i":"msg_123","a":"Let me check that file..."}
{"i":"tool_456","t":"...","v":{"type":"tool_call","name":"Read","args":{...}}}
{"i":"tool_456","t":"...","v":{"type":"tool_result","status":"success"}}
```

## Why Containers (Not Lambda)

Claude Code is a **CLI application** that:
- Spawns subprocesses (bash, git, npm, etc.)
- Maintains session state in `.claude/` folder
- Runs long agentic loops (minutes to hours)
- Needs persistent filesystem for code projects

Lambda constraints make it unsuitable:
- 15-minute max execution
- Read-only filesystem except `/tmp`
- No subprocess persistence between invocations

## Architecture

### Local Development

```
┌─────────────────────────────────────────────────────────────────┐
│  Cikada Server                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Docker Orchestrator                                     │   │
│  │  - Starts/stops containers on demand                    │   │
│  │  - Routes messages to running containers                │   │
│  │  - Tracks container state in SQLite                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│              │                                                  │
│              ▼                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Claude Code Container (per agent)                       │   │
│  │  - Node.js wrapper server (HTTP)                        │   │
│  │  - Spawns `claude` CLI with --output-format stream-json │   │
│  │  - Streams output to Tymbal via HTTP callback           │   │
│  │  - Idle monitor (5 min timeout)                         │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │  Volume Mount: /workspace                        │    │   │
│  │  │  ├── project/        (working directory)        │    │   │
│  │  │  └── .claude/        (session state)            │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### AWS Production (Fargate)

```
┌─────────────────────────────────────────────────────────────────┐
│  Orchestrator Lambda                                            │
│  - Receives messages from API Gateway                          │
│  - Starts/stops Fargate tasks                                  │
│  - Routes messages to running containers                       │
│  - Tracks container state in DynamoDB                          │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  ECS Fargate Cluster                                            │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Claude Code Container (per thread)                        │ │
│  │  - Same wrapper as local                                  │ │
│  │  ┌─────────────────────────────────────────────────────┐  │ │
│  │  │  EFS Mount: /workspace                               │  │ │
│  │  │  ├── project/        (user's code)                  │  │ │
│  │  │  └── .claude/        (session state)                │  │ │
│  │  └─────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Container Components

### Dockerfile

```dockerfile
FROM node:20-bullseye

# Install Claude Code CLI and dev tools
RUN npm install -g @anthropic-ai/claude-code
RUN apt-get update && apt-get install -y git bash curl jq python3

# Create non-root user (required for Claude Code)
RUN useradd -m -s /bin/bash claude
RUN mkdir -p /workspace && chown claude:claude /workspace

# Copy wrapper server
COPY dist/ /app/dist/
WORKDIR /app

USER claude

HEALTHCHECK --interval=30s --timeout=5s \
    CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080
CMD ["node", "dist/wrapper/server.js"]
```

### Wrapper Server

The wrapper server (`wrapper/server.ts`):
1. Receives messages via HTTP from orchestrator
2. Spawns Claude Code CLI with `--output-format stream-json`
3. Parses JSON output and translates to Tymbal frames
4. Streams frames to Cikada server via HTTP callback
5. Monitors idle time and self-terminates

### TymbalBridge

Translates Claude Code CLI output to Tymbal frames:

**Claude Code Output** (JSON lines):
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"Read","input":{}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
```

**Tymbal Output**:
```json
{"i":"msg_123","m":{"type":"assistant","sender":"claude-code"}}
{"i":"msg_123","a":"Let me look at that..."}
{"i":"tool_456","t":"...","v":{"type":"tool_call","name":"Read","args":{}}}
{"i":"result_789","t":"...","v":{"type":"tool_result","call_id":"...","status":"success"}}
```

## Message Flow

### First Message (Cold Start)

```
User → Server → Docker Orchestrator
                     │
                     ├─ Check state: no running container
                     ├─ Start container (docker run)
                     ├─ Wait for healthy (health check)
                     ├─ Update state table
                     ├─ POST /message to container
                     │
Container ───────────┤
    │                │
    ├─ Spawn: claude --output-format stream-json "message"
    ├─ Stream output → TymbalBridge → HTTP callback → Server
    └─ Reset idle timer
```

### Subsequent Messages (Warm)

```
User → Server → Docker Orchestrator
                     │
                     ├─ Check state: container running
                     ├─ POST /message directly to container
                     │
Container ───────────┤
    │                │
    ├─ Spawn: claude --continue --output-format stream-json "message"
    ├─ Stream output → TymbalBridge → HTTP callback → Server
    └─ Reset idle timer
```

### Resume After Timeout

```
User → Server → Docker Orchestrator
                     │
                     ├─ Check state: container stopped
                     ├─ Start NEW container
                     ├─ Mount SAME volume (preserves .claude/)
                     ├─ Wait for healthy
                     │
Container ───────────┤
    │                │
    ├─ Spawn: claude --continue --output-format stream-json "message"
    │         (--continue finds .claude/ on volume)
    └─ Resumes from previous context
```

## Environment Variables

### Container

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `THREAD_ID` | Thread identifier (channelId:callsign) |
| `CIKADA_API_URL` | Callback URL for Tymbal streaming |
| `CIKADA_CHANNEL_ID` | Channel ID for MCP artifacts |
| `CIKADA_CALLSIGN` | Agent callsign for MCP artifacts |
| `IDLE_TIMEOUT_MS` | Idle timeout (default: 300000 = 5 min) |

### MCP Configuration

When `CIKADA_CHANNEL_ID` and `CIKADA_CALLSIGN` are set, the container automatically enables MCP artifact tools, allowing the agent to interact with the channel board.

## Cost Considerations (AWS)

**Fargate Pricing** (us-east-1):
- 1 vCPU + 2GB = ~$0.049 per hour = ~$0.008 per 10-minute session

**EFS Pricing**:
- ~$0.30 per GB-month
- ~10GB per active project = $3/month per project

**Cost optimization**:
- Use FARGATE_SPOT for 70% savings
- Aggressive idle timeout (5-10 min)
- EFS lifecycle policies to archive old workspaces

## Security

1. **Container isolation**: Each agent gets separate container
2. **Non-root user**: Claude Code requires non-root for `--dangerously-skip-permissions`
3. **Network isolation**: Containers in private subnet (AWS)
4. **Secrets**: API key from Secrets Manager, not environment
5. **Volume isolation**: Each thread gets separate workspace directory
