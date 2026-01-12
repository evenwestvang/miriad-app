# Cast Backend

Multi-agent collaboration platform backend. Supports thousands of concurrent AI agents in Docker containers communicating via the Tymbal protocol.

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages (required on fresh clone)
pnpm build

# Copy environment template and fill in your credentials
cp .env.example .env

# Start development server
pnpm dev
```

The server will start at `http://localhost:3232` (or the PORT specified in .env).

## Architecture

```
packages/
├── core/       # Shared types, Tymbal protocol, @mention parser
├── server/     # Hono HTTP API, handlers, WebSocket
├── storage/    # PostgreSQL storage (PlanetScale)
├── runtime/    # Container orchestration (Docker/Fly.io)
└── deploy/     # SAM template, Lambda adapter
```

### Container Protocol

Agent containers communicate with the backend via the **Container Protocol v3.0**. If you're implementing a new runtime (beyond Docker/Fly.io), see the full specification:

📄 **[Container Protocol Spec v3.0](../design-notes/agent-server/container-protocol-spec-v3.md)**

Key concepts:
- `agentId` format: `{spaceId}:{channelId}:{callsign}`
- Fire-and-forget activation with `/agents/checkin` callback
- `routeHints` for platform-specific routing (e.g., Fly.io instance headers)
- 60s heartbeat staleness, 180s activation timeout

## Environment Variables

See `.env.example` for all available options:

| Variable | Description |
|----------|-------------|
| `PLANETSCALE_URL` | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | API key for Claude in containers |
| `PORT` | Server port (default: 3234) |
| `SPACE_ID` | Multi-tenant space ID (default: default-space) |
| `AGENT_IMAGE` | Docker image for agents (default: claude-code:local) |
| `AUTH_MODE` | **Required for local dev**: Set to `dev` to enable dev auth routes |

## API Endpoints

### Channels
- `GET /channels` - List all channels
- `POST /channels` - Create a channel
- `GET /channels/:id` - Get a channel
- `PUT /channels/:id` - Update a channel

### Roster
- `GET /channels/:id/roster` - List agents in channel
- `POST /channels/:id/roster` - Add agent to roster
- `DELETE /channels/:id/roster/:entryId` - Remove agent

### Agents
- `GET /agents` - List available agent types
- `POST /channels/:id/agents` - Add agent to channel (creates roster entry + spawns container)
- `DELETE /channels/:id/agents/:callsign` - Remove agent from channel
- `POST /agents/checkin` - Container registration (called by agent on startup)

### Messages
- `GET /channels/:id/messages` - Get messages (supports `forAgent` scoping)
- `POST /channels/:id/messages` - Send message (triggers agent invocation on @mentions)

### Tymbal (Container → Server)
- `POST /tymbal/:channelId` - Receive streaming frames from containers
- `POST /thread/:threadId/tymbal` - Legacy endpoint for existing containers

### Health
- `GET /health` - Health check

## Development

```bash
# Build all packages (required before first test run)
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

**Note:** Tests require packages to be built first since they import from `dist/`.

## How It Works

1. Human sends message with `@agent` mention
2. Server parses mentions and determines routing
3. AgentManager spawns Docker container for target agent
4. Container runs Claude Code, processes message
5. Agent streams response back via Tymbal protocol
6. Server broadcasts to WebSocket clients and persists to database

## Test Count

221 tests across 15 test files covering:
- Tymbal frame parsing and serialization
- @mention routing logic
- Container token authentication
- Storage operations (messages, channels, roster)
- Docker orchestrator lifecycle
- E2E integration flow

## AWS Deployment

### Quick Deploy

```bash
# Deploy everything (container + backend) to staging
./scripts/deploy-staging.sh

# Deploy backend only (faster, no container rebuild)
./scripts/deploy-staging.sh --backend

# Deploy container only
./scripts/deploy-staging.sh --container
```

### Prerequisites

- AWS CLI configured with `cikada-stag` profile
- Docker running
- SAM CLI installed (`brew install aws-sam-cli`)

### What Gets Deployed

1. **Agent Container** → ECR (`cast-agent:latest`)
2. **Backend API** → Lambda + API Gateway via SAM

### Staging Environment

- **API**: `https://9xq1buuixd.execute-api.us-east-1.amazonaws.com/stag`
- **ECR**: `455626925815.dkr.ecr.us-east-1.amazonaws.com/cast-agent:latest`
- **ECS Cluster**: `cast-agent-cluster`

### Debugging

```bash
# List running ECS tasks
aws ecs list-tasks --cluster cast-agent-cluster --profile cikada-stag

# Stop a stale container
aws ecs stop-task --cluster cast-agent-cluster --task <task-arn> --profile cikada-stag

# View container logs (CloudWatch)
# Log group: /ecs/cast-agent

# Clear agent callbackUrl for fresh spawn (PlanetScale)
# UPDATE roster SET callback_url = NULL WHERE callsign = 'agent-name';
```

### Agent Checkin Flow

When a container starts, it:
1. Calls `POST /agents/checkin` with its callback URL
2. Backend stores the URL in roster table
3. Backend pushes any pending messages to the container
4. Subsequent messages route directly to the container

If an agent isn't responding, check:
- Is the ECS task running? (`aws ecs list-tasks`)
- Did checkin succeed? (Check container logs)
- Is callbackUrl set in roster? (Check PlanetScale)

## Fly.io Deployment

The backend supports Fly.io Machines as an alternative to Docker/ECS for container orchestration. This is useful for development and smaller deployments.

### Prerequisites

- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account with an app created
- Docker running (for building images)

### Quick Start

```bash
# 1. Authenticate Docker with Fly registry
fly auth docker

# 2. Build and push container image (MUST be amd64)
cd agents/sandbox
docker buildx build --platform linux/amd64 -t registry.fly.io/YOUR_APP_NAME:latest --push .

# 3. Configure environment
# Add to backend/.env:
AGENT_RUNTIME=fly
FLY_API_TOKEN=your-fly-token
FLY_APP_NAME=your-app-name
FLY_REGION=iad
FLY_IMAGE=registry.fly.io/YOUR_APP_NAME:latest
CAST_API_URL=https://your-public-url.ngrok-free.app

# 4. Start the backend
pnpm dev
```

### Environment Variables (Fly.io)

| Variable | Description | Required |
|----------|-------------|----------|
| `AGENT_RUNTIME` | Set to `fly` to use Fly.io (default: `docker`) | Yes |
| `FLY_API_TOKEN` | Fly.io API token (get from `fly tokens create deploy`) | Yes |
| `FLY_APP_NAME` | Name of your Fly app | Yes |
| `FLY_REGION` | Fly region (default: `iad`) | No |
| `FLY_IMAGE` | Full image path in Fly registry | Yes |
| `CAST_API_URL` | Public URL where containers can reach the backend | Yes |

### Building the Container Image

**Important:** Fly Machines run on `linux/amd64`. If you're on an ARM machine (M1/M2 Mac), you must cross-compile:

```bash
cd agents/sandbox

# Build for amd64 platform (required even on ARM Macs)
docker buildx build --platform linux/amd64 -t registry.fly.io/YOUR_APP_NAME:latest --push .

# If buildx isn't set up, create a builder first:
docker buildx create --use
```

### Getting a Fly API Token

```bash
# Create a deploy token (recommended for CI/automation)
fly tokens create deploy -a YOUR_APP_NAME

# Or create an org token for broader access
fly tokens create org

# The token starts with "FlyV1 fm2_..."
```

### Creating a Fly App

```bash
# Create a new app (if you don't have one)
fly apps create YOUR_APP_NAME

# The app doesn't need any initial deployment -
# FlyRuntime creates Machines on demand
```

### Exposing Local Backend (for Development)

Containers running on Fly need to reach your local backend for checkin and Tymbal streaming. Use ngrok or similar:

```bash
# Expose local backend
ngrok http 3234

# Copy the HTTPS URL to CAST_API_URL in .env
# Example: https://abc123.ngrok-free.app
```

### How Fly.io Runtime Works

1. **Activation**: When an agent is @mentioned, `FlyRuntime` creates a Fly Machine via the Machines API
2. **Routing**: Each machine gets a unique ID stored in `routeHints['fly-force-instance-id']`
3. **Checkin**: Container calls `/agents/checkin` with its callback URL
4. **Message routing**: Messages are routed using the `fly-force-instance-id` header
5. **Suspend**: Machine is stopped and deleted via the Machines API

### Debugging Fly.io

```bash
# List machines in your app
fly machines list -a YOUR_APP_NAME

# View machine logs
fly logs -a YOUR_APP_NAME

# SSH into a running machine
fly ssh console -a YOUR_APP_NAME -s

# Force delete a stuck machine
fly machines destroy MACHINE_ID -a YOUR_APP_NAME --force
```

### Common Issues

**"machine not found" on suspend**
- The machine ID in roster might be stale
- Check if `routeHints['fly-force-instance-id']` is set correctly

**Container starts but no checkin**
- Verify `CAST_API_URL` is reachable from Fly
- Check container logs: `fly logs -a YOUR_APP_NAME`
- Ensure ngrok/tunnel is running if using local backend

**Platform mismatch errors**
- Always build with `--platform linux/amd64`
- Fly Machines don't support ARM images

**Rate limiting (429 errors)**
- FlyRuntime has built-in exponential backoff
- Avoid rapid activate/suspend cycles in testing

### Architecture Notes

The `FlyRuntime` class:
- Uses Planetscale Postgres (roster table) as state store - fully stateless for Lambda compatibility
- Stores real Fly machine IDs in `routeHints` for proper routing
- Implements fire-and-forget activation (returns immediately, container calls checkin)
- 180 second activation timeout with automatic machine cleanup
