# CAST

Multi-agent collaboration platform with real-time streaming.

## Project Structure

```
cast-app/
├── agents/
│   └── sandbox/          # Claude Code sandbox agent container
├── backend/
│   └── packages/
│       ├── core/         # Shared types, Tymbal protocol
│       ├── server/       # Hono API server
│       ├── storage/      # PostgreSQL storage layer
│       ├── runtime/      # Agent runtime utilities
│       └── deploy/       # AWS Lambda deployment
├── frontend/             # React web client
├── scripts/              # Build and deployment scripts
└── design-notes/         # Architecture documentation
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Docker (for local container builds)
- PostgreSQL (or PlanetScale connection)

### Install Dependencies

```bash
# Backend
cd backend && pnpm install

# Frontend
cd frontend && pnpm install

# Sandbox agent
cd agents/sandbox && pnpm install
```

### Configure Environment

```bash
# Copy environment template
cd backend && cp .env.example .env
```

Edit `backend/.env` with your credentials:

| Variable | Description | Required |
|----------|-------------|----------|
| `PLANETSCALE_URL` | PostgreSQL connection string | Yes |
| `ANTHROPIC_API_KEY` | API key for Claude in containers | Yes |
| `AUTH_MODE` | Set to `dev` for local development | Yes (local) |
| `PORT` | Server port (default: 3234) | No |
| `AGENT_IMAGE` | Docker image for agents | No |

### Build

```bash
# Backend (all packages)
cd backend && pnpm build

# Frontend
cd frontend && pnpm build

# Sandbox agent
cd agents/sandbox && pnpm build
```

### Run Tests

```bash
cd backend && pnpm test
```

## Local Container Builds

Build agent containers for local Docker testing:

```bash
# Build all containers
./scripts/build-containers.sh

# Build sandbox only
./scripts/build-containers.sh --sandbox

# Fresh build (no cache)
./scripts/build-containers.sh --no-cache
```

### Running the Sandbox Container Locally

```bash
docker run \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e CALLSIGN=fox \
  -e CHANNEL_ID=test-channel \
  -e CAST_SERVER_URL=http://host.docker.internal:3001 \
  -p 8080:8080 \
  claude-code:local
```

Environment variables:
- `ANTHROPIC_API_KEY` - Claude API key (required)
- `CALLSIGN` - Agent's callsign in the channel
- `CHANNEL_ID` - Channel to join
- `CAST_SERVER_URL` - Backend server URL (use `host.docker.internal` for local dev)
- `WORKSPACE_DIR` - Working directory inside container (default: `/workspace`)
- `IDLE_TIMEOUT_MS` - Idle timeout in ms (default: 600000)

## Tymbal Protocol

CAST uses the Tymbal protocol for real-time message streaming. See `design-notes/agent-server/tymbal-spec.md` for the full specification.

### Message Types

| Type | Description |
|------|-------------|
| `user` | Human message |
| `agent` | Agent response |
| `tool_call` | Tool invocation |
| `tool_result` | Tool execution result |
| `thinking` | Agent thinking trace |
| `status` | Status update |
| `error` | Error message |
| `idle` | Agent turn complete |

## Deployment

```bash
# Deploy to staging (AWS)
./scripts/deploy-staging.sh --all
```

## License

Proprietary - All rights reserved.
