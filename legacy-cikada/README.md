```
 ██████╗██╗██╗  ██╗ █████╗ ██████╗  █████╗
██╔════╝██║██║ ██╔╝██╔══██╗██╔══██╗██╔══██╗
██║     ██║█████╔╝ ███████║██║  ██║███████║
██║     ██║██╔═██╗ ██╔══██║██║  ██║██╔══██║
╚██████╗██║██║  ██╗██║  ██║██████╔╝██║  ██║
 ╚═════╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝
 D U R A B L E ᯼ A G E N T ᯼ S Y S T E M
```

A multi-agent orchestration platform with real-time streaming, Docker sandboxing, and MCP tool integration.

## Quick Start

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+ (`npm install -g pnpm`)
- **Docker** (for sandbox mode)
- **Anthropic API Key** (set `ANTHROPIC_API_KEY` environment variable)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd cicada
pnpm install
pnpm build

# Create .env file in packages/server
echo "ANTHROPIC_API_KEY=sk-ant-..." > packages/server/.env
```

### Running the Stack

From the project root:

```bash
# Start the server (runs at http://localhost:3001)
pnpm dev:server

# In a separate terminal, start the frontend (runs at http://localhost:5173)
pnpm dev:web
```

Or start both in parallel:

```bash
pnpm dev
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start all packages in dev mode (parallel) |
| `pnpm dev:server` | Start only the server |
| `pnpm dev:web` | Start only the web frontend |
| `pnpm dev:web:aws` | Start web frontend connected to AWS staging backend |
| `pnpm start:server` | Start server in production mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm clean` | Remove dist and node_modules |

## Running with Docker Sandbox

For Claude Code agents running in isolated Docker containers:

```bash
# 1. Build the Claude Code Docker image
cd packages/fargate-runtime
./scripts/build-local.sh

# 2. Start server with sandbox enabled
cd packages/server
pnpm dev -- --sandbox

# Or set environment variable
ENABLE_SANDBOX=true pnpm dev
```

When `--sandbox` is enabled:
- Agents with `engine: "claude-code"` run in Docker containers
- Each agent gets an isolated workspace at `~/.cikada/workspaces/<thread>:<callsign>/`
- MCP artifact tools are automatically available to containerized agents
- Containers auto-terminate after 5 minutes of idle time

## Project Structure

```
cicada/
├── packages/
│   ├── server/           # @cikada/server - HTTP API + WebSocket server
│   ├── web/              # @cikada/web - React frontend
│   ├── core/             # @cikada/core - Shared types and utilities
│   ├── storage/          # @cikada/storage - SQLite persistence
│   ├── agent/            # @cikada/agent - Agent definition framework
│   ├── local-runtime/    # @cikada/local-runtime - Artifact storage, Docker orchestration
│   ├── fargate-runtime/  # @cikada/fargate-runtime - Docker container runtime
│   ├── aws-runtime/      # @cikada/aws-runtime - AWS Lambda deployment
│   └── mcp/              # @cikada/mcp - MCP server for artifacts
└── spec/                 # Specifications (Tymbal protocol)
```

## Key Packages

### @cikada/server

The main HTTP and WebSocket server. Handles:
- Channel management (CRUD)
- Message routing between humans and agents
- Agent spawning and lifecycle management
- Real-time streaming via WebSocket

**CLI Options:**
```bash
cikada-server [options]

  --port, -p    Port to listen on (default: 3001)
  --db          SQLite database path (default: ./cikada.db)
  --memory      Use in-memory database
  --sandbox     Enable Docker sandbox for Claude Code agents
```

### @cikada/web

React frontend with:
- Channel listing and creation
- Real-time chat interface
- Tymbal streaming support
- Tool call/result visualization
- Artifact board viewer

### @cikada/fargate-runtime

Docker container runtime for Claude Code agents:
- Wraps Claude Code CLI with HTTP interface
- Streams events via Tymbal protocol
- MCP artifact tools integration
- Health check endpoint at `/health`

**Building the Docker image:**
```bash
cd packages/fargate-runtime
./scripts/build-local.sh
```

## API Reference

### HTTP Endpoints

```
POST   /channels              Create channel
GET    /channels              List channels
GET    /channels/:id          Get channel details
DELETE /channels/:id          Delete channel

POST   /channels/:id/messages     Send message
GET    /channels/:id/messages     Get message history

POST   /channels/:id/spawn        Spawn agent in channel
DELETE /channels/:id/agents/:id   Remove agent

GET    /channels/:id/artifacts    List artifacts
POST   /channels/:id/artifacts    Create artifact
GET    /channels/:id/artifacts/:slug    Get artifact
PUT    /channels/:id/artifacts/:slug    Update artifact

GET    /health                Health check
```

### WebSocket Streaming

Connect to `ws://localhost:3001/channels/:channelId/stream` for real-time updates.

Messages follow the Tymbal protocol:
```json
// Start streaming message
{"i": "msgId", "m": {"type": "assistant", "sender": "agent-name"}}

// Append content
{"i": "msgId", "a": "streaming text..."}

// Finalize message
{"i": "msgId", "t": "2024-01-01T00:00:00Z", "v": {"type": "assistant", "content": "..."}}

// Tool calls
{"i": "toolId", "t": "...", "v": {"type": "tool_call", "name": "Read", "args": {...}}}

// Tool results
{"i": "resultId", "t": "...", "v": {"type": "tool_result", "status": "success", "content": "..."}}
```

See `spec/Tymbal.md` for the full protocol specification.

## Development Workflow

### Building

```bash
# Build all packages
pnpm build

# Build specific package
cd packages/server && pnpm build

# Watch mode (auto-rebuild on changes)
cd packages/server && pnpm dev
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for specific package
cd packages/core && pnpm test
```

### Common Development Tasks

**1. Restart everything fresh:**
```bash
# Stop all processes
pkill -f "tsx watch"
pkill -f "vite"

# Clean and rebuild
pnpm clean
pnpm install
pnpm build

# Start server + frontend
cd packages/server && pnpm dev &
cd packages/web && pnpm dev &
```

**2. Rebuild Docker image after changes:**
```bash
cd packages/fargate-runtime
pnpm build
./scripts/build-local.sh
```

**3. Debug container issues:**
```bash
# Check running containers
docker ps

# View container logs
docker logs <container-id>

# Shell into running container
docker exec -it <container-id> /bin/bash
```

**4. Clear local databases:**
```bash
rm packages/server/cikada.db
rm ~/.cikada/container-state.db
```

## Environment Variables

### Server (.env in packages/server)

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required) | - |
| `ENABLE_SANDBOX` | Enable Docker sandbox | `false` |
| `PORT` | Server port | `3001` |

### Docker Container

These are set automatically by the orchestrator:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Passed from server |
| `THREAD_ID` | Thread identifier (channel:callsign) |
| `CIKADA_API_URL` | Callback URL for Tymbal streaming |
| `CIKADA_CHANNEL_ID` | Channel ID for MCP artifacts |
| `CIKADA_CALLSIGN` | Agent callsign for MCP artifacts |
| `IDLE_TIMEOUT_MS` | Container idle timeout (default: 300000) |

## Troubleshooting

### "Address already in use" error

```bash
# Find process using port
lsof -i :3001

# Kill it
kill -9 <PID>
```

### Container starts but agent doesn't respond

1. Check container health: `docker ps`
2. View container logs: `docker logs <id>`
3. Verify `ANTHROPIC_API_KEY` is set in server environment

### "table has no column named X" SQLite errors

Schema migrations are automatic but may need a fresh database:
```bash
rm packages/server/cikada.db
# Restart server - tables will be recreated
```

### Frontend not connecting to WebSocket

1. Check server is running on correct port
2. Check browser console for CORS errors
3. Verify `vite.config.ts` has `server.allowedHosts: true`

## AWS Deployment

The project includes two deployment architectures for AWS:

### @cikada/aws-runtime (Lambda + Durable Execution)

Traditional serverless deployment using AWS Lambda with durable execution for long-running agents.

**Infrastructure (SAM template in `packages/aws-runtime/template.yaml`):**
- DynamoDB tables for connections, threads, and metadata
- WebSocket API Gateway for real-time streaming
- HTTP API Gateway for REST endpoints
- Lambda functions with durable execution support

**Status:** Infrastructure templates complete. Requires Lambda Durable SDK integration.

```bash
# Deploy (requires AWS SAM CLI)
cd packages/aws-runtime
sam build
sam deploy --guided \
  --parameter-overrides AnthropicApiKeySecretArn=arn:aws:secretsmanager:...
```

### @cikada/fargate-runtime (ECS Fargate + Claude Code)

Production deployment running Claude Code CLI in Fargate containers with EFS persistent storage.

**Infrastructure (SAM template in `packages/fargate-runtime/template.yaml`):**
- ECS Cluster for Fargate tasks
- EFS filesystem for persistent agent workspaces
- Lambda orchestrator for task management
- Security groups for container networking

**Status:** Infrastructure templates complete. Docker image ready.

```bash
# 1. Push container image to ECR
cd packages/fargate-runtime
./scripts/ecr-push.sh

# 2. Deploy infrastructure
sam build
sam deploy --guided \
  --parameter-overrides \
    AnthropicApiKeySecretArn=arn:aws:secretsmanager:... \
    VpcId=vpc-xxx \
    SubnetIds=subnet-xxx,subnet-yyy \
    ContainerImage=123456789.dkr.ecr.region.amazonaws.com/claude-code:latest \
    CikadaApiUrl=https://xxx.execute-api.region.amazonaws.com/prod
```

### Deploying to cikada-stag Stack

The `cikada-stag` stack is the **only AWS deployment target** for the reactive agent backend. There is no production stack at this time.

**Prerequisites:**
- AWS SAM CLI (`pip install aws-sam-cli`)
- AWS profile `cikada-stag` configured with access to account `455626925815`
- Anthropic API key set in the deployed stack's Secrets Manager

**Deploy (recommended - use the script):**
```bash
cd deploy/cikada-redux
./scripts/deploy-stag.sh
```

The script will:
1. Verify you're targeting the correct AWS account
2. Build and deploy the SAM stack
3. Output the stack endpoints
4. Update `packages/web/.env.aws` with current endpoints (commit if changed)

**Manual Deploy (alternative):**
```bash
cd deploy/cikada-redux
sam build
sam deploy --config-env cikada-stag
```

Or with explicit flags:
```bash
sam deploy --stack-name cikada-stag \
  --profile cikada-stag \
  --region us-east-1 \
  --no-confirm-changeset \
  --capabilities CAPABILITY_IAM
```

**Testing with AWS backend:**
```bash
cd packages/web
pnpm dev:aws
```

**Important Notes:**
- Always use `--config-env cikada-stag` or the deploy script to avoid wrong-account deploys
- The deploy script updates `packages/web/.env.aws` - commit if endpoints change
- The `API_URL` env var is derived at runtime from request headers (no CloudFormation config needed)
- Stack endpoints are stable unless the stack is deleted and recreated

### Deployment Prerequisites

- AWS SAM CLI (`pip install aws-sam-cli`)
- AWS credentials configured (`aws configure`)
- Anthropic API key stored in Secrets Manager
- VPC with private subnets (for Fargate deployment)

## Architecture

### Local Development

```
┌─────────────────┐     ┌──────────────────┐
│   Web Client    │────▶│  Cikada Server   │
│  (React/Vite)   │     │   (HTTP + WS)    │
└─────────────────┘     └────────┬─────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
            ┌───────────┐ ┌───────────┐ ┌───────────┐
            │  SQLite   │ │  Anthropic│ │  Docker   │
            │ (Storage) │ │    API    │ │ Sandbox   │
            └───────────┘ └───────────┘ └─────┬─────┘
                                              │
                                    ┌─────────┴─────────┐
                                    ▼                   ▼
                            ┌───────────────┐   ┌───────────────┐
                            │ Claude Code   │   │ Claude Code   │
                            │  Container 1  │   │  Container 2  │
                            └───────────────┘   └───────────────┘
```

### AWS Fargate Deployment

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Web Client    │────▶│  API Gateway     │────▶│  Lambda          │
│                 │     │  (HTTP + WS)     │     │  (Orchestrator)  │
└─────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                          │
                        ┌─────────────────────────────────┼─────────────────────────────────┐
                        ▼                                 ▼                                 ▼
                ┌───────────────┐                 ┌───────────────┐                 ┌───────────────┐
                │   DynamoDB    │                 │  ECS Fargate  │                 │     EFS       │
                │   (State)     │                 │   (Agents)    │                 │ (Workspaces)  │
                └───────────────┘                 └───────────────┘                 └───────────────┘
```

**Data Flow:**
1. User sends message via HTTP POST to `/channels/:id/messages`
2. Server routes to agent (direct or via Docker container)
3. Agent streams responses via Tymbal protocol
4. WebSocket broadcasts to all connected clients
5. Frontend renders messages in real-time

## Project Status

| Component | Status | Notes |
|-----------|--------|-------|
| Server (`@cikada/server`) | ✅ Working | HTTP + WebSocket API |
| Frontend (`@cikada/web`) | ✅ Working | React + Tymbal streaming |
| Local Docker sandbox | ✅ Working | Claude Code in containers |
| MCP artifact tools | ✅ Working | Agents can create/read artifacts |
| Tool call streaming | ✅ Working | Real-time tool visibility in UI |
| AWS Lambda runtime | 🔨 Templates ready | Needs integration testing |
| AWS Fargate runtime | 🔨 Templates ready | Needs deployment testing |

## License

MIT
