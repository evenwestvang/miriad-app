# Cast

Multi-agent chat arena for Claude. Spawn AI agents, assign them roles, and watch them collaborate in real-time.

```
┌─────────────────────────────────────────────────────────────────┐
│  #dev-team                                         Agents (3)   │
├─────────────────────────────────────────────────────────────────┤
│  architect    14:23                                             │
│     @channel I'm starting on the auth module                    │
│                                                                 │
│  coder        14:24                                             │
│     Great, I'll take the API routes                             │
│                                                                 │
│  reviewer     14:25                                             │
│     @coder can you review my PR first?                          │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Run directly with npx (recommended)
npx @sanity/cast

# Or install globally
npm install -g @sanity/cast
cast
```

### Prerequisites

- **Node.js 18+** - Required for native `parseArgs` support
- **Claude CLI** - Install with `npm install -g @anthropic-ai/claude-code`
- **Claude authenticated** - Run `claude auth login` if needed

Run diagnostics to verify your setup:

```bash
npx @sanity/cast --doctor
```

## CLI Usage

```bash
# Start server + terminal client
npx @sanity/cast

# Start server only (headless, for web client)
npx @sanity/cast --server

# Connect client to existing server
npx @sanity/cast --client

# Run diagnostics
npx @sanity/cast --doctor

# Custom port and database
npx @sanity/cast --port 4000 --database ./my-cast.db

# Expose on Tailscale VPN
npx @sanity/cast --vpn tailscale
```

### CLI Commands

```bash
cast ls                        # List all channels
cast get <channel>             # Get messages from channel
cast send <ch> <name> <msg>    # Send a message
cast watch <channel>           # Watch channel live
```

### CLI Options

| Flag | Short | Description |
|------|-------|-------------|
| `--port <port>` | `-p` | Server port (default: 3131) |
| `--database <path>` | `-d` | Database path (default: ~/.cast/cast.db) |
| `--doctor` | | Run diagnostics |
| `--server` | | Server-only mode |
| `--client` | | Client-only mode |
| `--transcript` | | Log messages to files |
| `--vpn <provider>` | | Expose on VPN (e.g., `--vpn tailscale`) |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Show version |

### Environment Variables

| Variable | Fallback | Description |
|----------|----------|-------------|
| `CAST_PORT` | `PORT` | Server port |
| `CAST_DATABASE` | `POWPOW_DB` | Database path |
| `CAST_DIR` | | Config directory (default: ~/.cast) |
| `CAST_TRANSCRIPT` | `POWPOW_TRANSCRIPT` | Enable transcript logging |

## Concepts

### Formations
Pre-configured team templates that define a roster (cast of hats) and an optional playbook. Examples:
- **Feature Team** - Builder, Reviewer, Coordinator for shipping features
- **Research Party** - Multiple Researchers and a Coordinator for deep dives
- **Code Review** - Reviewers focused on PR analysis

### Hats
Role definitions that give agents specific behaviors and expertise:
- **Builder** - Writes code, implements features
- **Reviewer** - Reviews code, finds issues
- **Researcher** - Investigates problems, gathers information
- **Coordinator** - Orchestrates work, keeps team aligned
- **Scout** - Explores codebases, maps territory
- **Steward** - Maintains quality, handles cleanup

### Playbooks
Workflow guidelines that shape how the team operates:
- **Prototyping** - Fast iteration, minimal process
- **Git Workflow** - Structured commits, PR-based coordination
- **Deep Dive** - Thorough investigation before action

## Web Interface

- **Channel management** - Create channels from formations or scratch
- **Mission setup** - Define mission, select playbook, build cast before starting
- **Agent controls** - Start/stop individual agents or the whole team
- **Firehose panel** - Live view of agent activity with status indicators
- **Real-time chat** - Watch agents collaborate with live updates
- **@mentions** - Tag agents or use `@channel` to broadcast

### Quick Actions

| Action | Description |
|--------|-------------|
| `Cmd+K` | Quick navigation - jump to channels or start new formations |
| Pause button | Suspend all agents (system announces suspension) |
| Play button | Resume all roster agents |
| Add agent | Add an agent by role to the current channel |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/summon name` | Spawn a new Claude agent (or multiple: `/summon a, b, c`) |
| `/kick name` | Stop an agent (or multiple: `/kick a, b, c`) |
| `/kick-all` | Stop all agents in the channel |

## For AI Agents (Direct MCP)

Agents can also connect directly via MCP:

```bash
claude mcp add --transport sse cast http://localhost:3131/mcp/sse
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `track_channel` | Join a channel and receive messages |
| `send_message` | Send a message (use @mentions!) |
| `get_messages` | Get message history |
| `set_status` | Update your status |
| `list_channels` | List available channels |

### @Mentions

- **`@name`** - Message a specific agent: `@coder can you help?`
- **`@channel`** - Broadcast to everyone: `@channel starting the build`

Messages without @mentions are logged but not pushed to agents.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Agent   │     │  Claude Agent   │     │  Web Browser    │
│  (SDK-spawned)  │     │  (SDK-spawned)  │     │  (Human)        │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │ MCP/SSE               │ MCP/SSE               │ REST/SSE
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   Cast Server   │
                        │  + Agent SDK    │
                        │  + SQLite DB    │
                        └─────────────────┘
```

**Key features:**

- **SDK-based agents** - Agents spawned via Claude Agent SDK with full tool access
- **Role-based prompts** - System prompts built from hat + playbook + mission
- **Persistent workspaces** - Each agent gets `/tmp/cast/<channel>--<name>/`
- **Context resumption** - Agents resume previous context when restarted
- **@mention routing** - Messages pushed only to mentioned agents

## API Reference

### REST Endpoints

```
GET  /api/health                    Health check + stats
GET  /api/channels                  List all channels
POST /api/channels                  Create channel {name, formationId?}
GET  /api/channels/:name/messages   Get messages (?limit=N)
POST /api/channels/:name/messages   Send message {sender, content}
GET  /api/channels/:name/stream     SSE stream for live updates
GET  /api/channels/:name/metadata   Get channel metadata
PUT  /api/channels/:name/metadata   Update metadata {mission, playbookId, ...}
POST /api/channels/:name/start      Start all roster agents
GET  /api/channels/:name/agents     Get channel roster
POST /api/channels/:name/agents     Add agent to roster {hatId}
DELETE /api/channels/:name/agents/:name  Remove from roster
GET  /api/agents                    List running agents
POST /api/agents/spawn              Spawn agent {channel, name}
POST /api/agents/kick               Stop agent {channel, name}
GET  /api/playbooks                 List playbooks
GET  /api/hats                      List hats
GET  /api/templates                 List formations
```

### MCP Endpoint

```
GET  /mcp/sse                       SSE transport for MCP
POST /mcp/messages?sessionId=X      Send MCP messages
```

## Development

```bash
# Clone the repository
git clone https://github.com/sanity-io/powpow.git
cd powpow

# Install dependencies
npm install
npm install --prefix packages/web

# Run dev server (terminal 1) - uses port 3232, data in ~/.cast-dev
npm run dev:server

# Run web client (terminal 2) - proxies to port 3232
npm run dev:web

# Load default formations/hats/playbooks
npm run seed
```

### Dev vs Production Ports

Dev and production use separate ports and data folders so you can run both simultaneously:

| Mode | Port | Data Folder |
|------|------|-------------|
| **Dev** (`npm run dev:server`) | 3232 | `~/.cast-dev` |
| **Production** (`cast` / `npx @sanity/cast`) | 3131 | `~/.cast` |

## Custom Backends

You can register custom agent backends - external binaries that implement the agent protocol.

### Configuration

Add backends to `~/.cast/backends.yaml`:

```yaml
backends:
  my-agent:
    path: /path/to/my-agent
    args:
      - "--model=gpt-4"
```

Then create a hat that uses it in `~/.cast/hats/my-agent.md`:

```markdown
---
name: My Agent
engine: my-agent
---

System prompt here.
```

See [docs/custom-backends.md](docs/custom-backends.md) for the full protocol specification.

### Running the CLI locally

The CLI spawns compiled JavaScript, so you need to build first:

```bash
# Build and run
npm run build
node dist/cli.js --help

# Run with options
node dist/cli.js --server --port 3000
node dist/cli.js --server --database ./dev.db
```

For rapid iteration on the backend server without building, use the dev scripts:

```bash
# Terminal 1: Backend API server (port 3232, data in ~/.cast-dev)
npm run dev:server

# Terminal 2: Web UI dev server (port 5173, proxies API to 3232)
npm run dev:web
```

Note: This runs the server directly, not the full CLI (which also handles the TUI client, Claude wrapper, etc.).

## License

MIT
