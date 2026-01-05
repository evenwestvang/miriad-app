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
├── runtime/    # Container orchestration (Docker/Fargate)
└── deploy/     # SAM template, Lambda adapter
```

## Environment Variables

See `.env.example` for all available options:

| Variable | Description |
|----------|-------------|
| `PLANETSCALE_URL` | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | API key for Claude in containers |
| `PORT` | Server port (default: 3232) |
| `SPACE_ID` | Multi-tenant space ID (default: default-space) |
| `AGENT_IMAGE` | Docker image for agents (default: claude-code:local) |

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
