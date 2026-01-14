# Local Runtime Architecture & Backend Integration

This document describes how the `@caststack/local-runtime` package works and how it integrates with the Cast backend server.

## Overview

The local-runtime enables running Cast agents on a user's local machine. It acts as a bridge between the Cast backend (via WebSocket) and multiple Claude SDK agent instances, providing:

- Agent lifecycle management (activate, message, suspend)
- Workspace isolation per agent
- Real-time communication with the Cast platform
- Message queueing and batching
- MCP server configuration injection

## Package Structure

```
backend/packages/local-runtime/
├── src/
│   ├── index.ts           # Main exports
│   ├── types.ts           # Protocol & interface definitions
│   ├── config.ts          # Configuration management
│   ├── runtime-client.ts  # WebSocket connection handler
│   ├── agent-manager.ts   # Agent lifecycle management
│   ├── tymbal-bridge.ts   # SDK message translation
│   └── cli.ts             # Command-line interface
```

## Core Components

### RuntimeClient (`runtime-client.ts`)

Manages WebSocket connection to the backend:

- Connects to `{wsUrl}?protocol=runtime` with `Server {secret}` auth header
- Sends `runtime_ready` message on connection with machine info
- Routes backend commands to AgentManager
- Sends agent frames back to backend
- Handles reconnection with exponential backoff (1s → 30s max)
- Sends heartbeats every 30s for online agents

### AgentManager (`agent-manager.ts`)

Manages multiple local agent instances:

- Creates isolated workspaces: `/tmp/cast-agents/{spaceId}/{channelId}/{callsign}`
- Initializes Claude SDK with `claude-opus-4-5-20251101` model
- Uses `claude_code` system prompt preset with custom append
- Queues messages when agent is busy (one at a time execution)
- Tracks agent states: `offline` → `activating` → `online` → `busy`

### TymbalBridge (`tymbal-bridge.ts`)

Translates Claude SDK messages to Tymbal protocol frames:

- `agent` frames - text output from Claude
- `tool_call` frames - tool invocations
- `tool_result` frames - tool responses
- `cost` frames - token usage metrics
- `idle` frames - signals processing complete

## Protocol Messages

### Backend → Local Runtime

| Message | Purpose |
|---------|---------|
| `runtime_connected` | Ack connection registration |
| `activate` | Start agent with system prompt & MCP config |
| `message` | Deliver user message to agent |
| `suspend` | Shutdown agent |
| `ping` | Liveness check |

### Local Runtime → Backend

| Message | Purpose |
|---------|---------|
| `runtime_ready` | Initial registration handshake |
| `agent_checkin` | Agent initialized and ready |
| `agent_heartbeat` | Periodic liveness (every 30s) |
| `frame` | Tymbal frame with agent output |
| `pong` | Response to ping |

## Backend Integration Points

### WebSocket Connection

In `backend/packages/server/src/dev.ts`:

```typescript
// Lines 268-280 - Initialize manager
const runtimeConnectionManager = createRuntimeConnectionManager({
  storage,
  connectionManager,
  agentStateManager,
  requireAuth: false,  // Dev mode
});

// Lines 346-363 - WebSocket upgrade
if (pathname === '/runtimes/connect' || protocol === 'runtime') {
  runtimeWss.handleUpgrade(request, socket, head, (ws) => {
    runtimeConnectionManager.handleConnection(ws, authHeader);
  });
}
```

### Message Routing

In `backend/packages/server/src/agents/invoker-adapter.ts`:

When a user sends a message, the invoker checks if the agent is bound to a local runtime:

1. Check `rosterEntry.runtimeId` - is agent on local runtime?
2. Verify runtime is online via `runtimes` table
3. If agent has recent heartbeat → send `message` command
4. If agent offline → send `activate` command first

### Key Backend Files

| File | Purpose |
|------|---------|
| `runtime-connection-manager.ts` | WebSocket connection pool |
| `runtime-protocol-handlers.ts` | Stateless protocol handlers |
| `runtime-auth.ts` | Server credential validation |
| `local-runtime.ts` (runtime pkg) | AgentRuntime implementation |

## Data Model

### Runtime Storage (`runtimes` table)

```typescript
interface StoredRuntime {
  id: string;           // ULID
  spaceId: string;
  serverId: string;     // FK to local_agent_servers
  name: string;         // e.g., "simen-macbook"
  type: 'local';
  status: 'online' | 'offline';
  config: {
    wsConnectionId: string;
    machineInfo?: { os: string; hostname: string };
  };
}
```

### Agent Binding

Agents are bound to local runtimes via `rosterEntry.runtimeId`. The `lastHeartbeat` field determines if the agent is currently active.

## Connection Sequence

```
Local Runtime                    Backend
     │                              │
     ├─ WebSocket connect ─────────→│ Create connection
     │                              │
     ├─ runtime_ready ─────────────→│ Save to DB (online)
     │                              │
     │←── runtime_connected ────────│
     │                              │
     │  (user sends @mention)       │
     │                              ├─ invokeAgents()
     │←── activate ─────────────────│ (if offline)
     │                              │
     ├─ agent_checkin ─────────────→│ Update roster
     │                              │
     │←── message ──────────────────│ (subsequent)
     │                              │
     ├─ frame (agent output) ──────→│ Persist + broadcast
     ├─ frame (tool_call) ─────────→│
     ├─ frame (tool_result) ───────→│
     ├─ frame (idle) ──────────────→│ Processing done
     │                              │
     │  (every 30s)                 │
     ├─ agent_heartbeat ───────────→│ Update liveness
```

## CLI Commands

```bash
# Authenticate with Cast backend
local-runtime auth "cast://bst_token@api.cast.dev/space_abc"

# Start the runtime
ANTHROPIC_API_KEY=sk-... local-runtime start

# Check status
local-runtime status
```

## Configuration

Stored at `~/.config/cast/local-runtime.json` (mode 0600):

```json
{
  "spaceId": "space_xxx",
  "name": "hostname",
  "credentials": {
    "runtimeId": "rt_...",
    "serverId": "...",
    "secret": "...",
    "apiUrl": "https://...",
    "wsUrl": "wss://..."
  },
  "workspace": {
    "basePath": "/tmp/cast-agents"
  }
}
```

## Key Design Decisions

1. **Fire-and-forget activation**: Backend sends activate but doesn't wait. State transitions happen via `agent_checkin` message.

2. **Message queueing**: Only one message processed at a time per agent. Queued messages are batched together.

3. **Session continuity**: Claude sessions persist in `.claude/` directory, enabling multi-turn conversations.

4. **Workspace isolation**: Each agent gets its own directory based on space/channel/callsign.

5. **Protocol split**: `runtime-protocol-handlers.ts` contains stateless logic for Lambda compatibility; `runtime-connection-manager.ts` handles WebSocket state.
