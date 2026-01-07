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

## App Integrations

CAST supports OAuth-based app integrations that give agents access to external tools. When an agent is spawned, connected apps are automatically converted to MCP server configurations and passed to the container.

### Supported Providers

- **GitHub** - Provides repository access, issues, PRs via the GitHub MCP server

### Setup

1. **Create a GitHub OAuth App** at https://github.com/settings/developers
   - Set the callback URL to `${CAST_API_URL}/api/apps/callback/github`
   - For local dev: `http://localhost:3234/api/apps/callback/github`

2. **Configure environment variables** in `backend/.env`:
   ```bash
   # Required for OAuth
   CAST_API_URL=http://localhost:3234
   SECRET_KEY=<generate with: openssl rand -base64 32>

   # GitHub credentials
   GITHUB_CLIENT_ID=your-client-id
   GITHUB_CLIENT_SECRET=your-client-secret
   ```

3. **Create a `system.app` artifact** in your channel:
   ```json
   {
     "type": "system.app",
     "slug": "github-app",
     "props": { "provider": "github" }
   }
   ```

4. **Connect the app** via the frontend UI - this initiates OAuth flow and stores tokens

5. **Spawn an agent** - connected apps are automatically passed as MCP servers

### How It Works

1. User creates a `system.app` artifact with `provider: "github"`
2. User clicks "Connect" which opens GitHub OAuth popup
3. After authorization, tokens are encrypted and stored in the artifact's `secrets` field
4. When spawning an agent, the orchestrator:
   - Finds all connected `system.app` artifacts in the channel
   - Derives MCP server configurations from them
   - Passes configs via `MCP_SERVERS` env var to the container
5. The agent container loads the MCP servers and has authenticated tool access

## Deployment

```bash
# Deploy to staging (AWS)
./scripts/deploy-staging.sh --all
```

## License

Proprietary - All rights reserved.
