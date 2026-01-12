# Container Communication Protocol Specification

**Version:** 3.0
**Status:** Implemented
**Authors:** @protoz, @flyfly, @cont, @fig

## Overview

This document defines the standard communication protocol between agent containers and the Cast backend. It applies to all runtime implementations (Docker, Fargate, Fly.io, and future engines).

**Key design principles:**
1. **Agents are permanent, containers are ephemeral** — Agents exist in the roster; containers are just their runtime manifestation
2. **Consistent identity model** — One canonical way to identify agents across all layers
3. **Explicit state machines** — Clear states, transitions, guards, and invariants
4. **Maximum code sharing** — Runtime-specific logic is minimal and well-isolated

The protocol consists of four layers:
1. **Identity Model** — How agents and containers are identified
2. **Runtime Interface** — Backend-to-runtime interface for activating/suspending agents
3. **Container HTTP API** — Endpoints the container must expose
4. **Backend HTTP API** — Endpoints the container calls back to

---

## 1. Identity Model

### Agent Identity (Permanent)

An agent is uniquely identified by three components:

```typescript
interface AgentId {
  spaceId: string;      // Workspace isolation boundary
  channelId: string;    // Channel the agent belongs to
  callsign: string;     // Unique name within the channel
}
```

**Canonical string format:** `{spaceId}:{channelId}:{callsign}`

This identity is:
- **Permanent** — exists in roster regardless of container state
- **Deterministic** — same inputs always produce the same identity
- **Hierarchical** — enables scoping (all agents in a space, all agents in a channel)

```typescript
// Shared utility — MUST be used by all runtimes
function formatAgentId(id: AgentId): string {
  return `${id.spaceId}:${id.channelId}:${id.callsign}`;
}

function parseAgentId(agentId: string): AgentId {
  const [spaceId, channelId, callsign] = agentId.split(':');
  if (!spaceId || !channelId || !callsign) {
    throw new Error(`Invalid agentId format: ${agentId}`);
  }
  return { spaceId, channelId, callsign };
}
```

### Container Identity (Ephemeral)

A container is a runtime instance that executes an agent. Container identity is:
- **Runtime-specific** — Docker container ID, Fly Machine ID, ECS Task ARN
- **Ephemeral** — destroyed when agent is suspended, recreated on activation
- **Opaque to protocol** — backend treats it as an opaque string

```typescript
interface ContainerInfo {
  containerId: string;     // Runtime-specific identifier
  runtime: RuntimeType;    // 'docker' | 'fly' | 'fargate' | 'mock'
}

type RuntimeType = 'docker' | 'fly' | 'fargate' | 'mock';
```

### Relationship

```
┌─────────────────────────────────────────────────────────────┐
│                         ROSTER                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Agent: space1:general:fox                            │    │
│  │ Status: online                                       │    │
│  │ Container: { id: "d4e5f6", runtime: "fly" }         │    │
│  │ Endpoint: https://cast-agents.fly.dev               │    │
│  │ RouteHints: { "fly-force-instance-id": "d4e5f6" }   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Agent: space1:general:bear                           │    │
│  │ Status: offline                                      │    │
│  │ Container: null                                      │    │
│  │ Endpoint: null                                       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Agent State Machine

### States

| State | Description | Container Running? | Can Receive Messages? |
|-------|-------------|-------------------|----------------------|
| `offline` | Agent exists but has no container | No | No (queued) |
| `activating` | Container starting, waiting for checkin | Starting | No (queued) |
| `online` | Container running, ready for messages | Yes | Yes |
| `busy` | Processing a message (informational) | Yes | Yes (queued) |
| `suspending` | Container shutting down gracefully | Stopping | No (queued) |
| `error` | Container failed, needs intervention | No | No (queued) |

**Note on `busy` state:** This is informational and tracked locally by the container (e.g., `isProcessing` flag). The backend does not persist this state in the roster. It's used for health checks and preventing duplicate message delivery. Core implementation should focus on `offline`, `activating`, `online`, `suspending` first; `busy` and `error` can be added later.

### State Diagram

```
                                    ┌──────────────────────────────────┐
                                    │                                  │
                                    ▼                                  │
┌─────────┐  activate()   ┌────────────────┐  checkin    ┌─────────┐  │
│         │──────────────▶│                │────────────▶│         │  │
│ OFFLINE │               │  ACTIVATING    │             │  ONLINE │──┘
│         │◀──────────────│                │◀────────────│         │
└─────────┘  timeout/     └────────────────┘  activate() └─────────┘
     ▲       error              │                             │
     │                          │ timeout                     │ message
     │                          │ (180s)                      │ received
     │                          ▼                             ▼
     │                    ┌─────────┐                   ┌─────────┐
     │                    │         │                   │         │
     │                    │  ERROR  │                   │  BUSY   │
     │                    │         │                   │         │
     │                    └─────────┘                   └─────────┘
     │                          │                             │
     │                          │ clear()                     │ response
     │                          │                             │ complete
     │                          ▼                             │
     │                    ┌─────────┐                         │
     └────────────────────│         │◀────────────────────────┘
        suspend()         │ SUSPEND │
        complete          │  -ING   │
                          └─────────┘
```

### Transitions

| From | Event | To | Guard | Action |
|------|-------|-----|-------|--------|
| `offline` | `activate()` | `activating` | — | Start container |
| `activating` | `checkin` received | `online` | Valid checkin | Store endpoint, deliver pending |
| `activating` | 180s timeout | `error` | — | Log error, cleanup |
| `activating` | Container crash | `error` | — | Log error |
| `online` | Message received | `busy` | — | Forward to container |
| `busy` | Response complete | `online` | — | Update activity |
| `online` | `suspend()` | `suspending` | — | Send shutdown, stop container |
| `online` | Heartbeat stale (60s) | `offline` | — | Clear routing |
| `online` | Push failure | `offline` | — | Clear routing |
| `suspending` | Container stopped | `offline` | — | Clear routing |
| `error` | `activate()` | `activating` | — | Retry |
| `error` | `clear()` | `offline` | — | Reset state |

### Invariants

1. **At most one container per agent** — An agent cannot have two containers running simultaneously
2. **Endpoint requires online** — `endpoint` and `routeHints` are only set when status is `online`
3. **Offline means no routing** — When `offline`, `endpoint` MUST be null
4. **Messages always delivered** — Messages to non-online agents are queued and delivered on activation

### Idempotency Rules

| Operation | Current State | Behavior |
|-----------|---------------|----------|
| `activate()` | `offline` | Start container → `activating` |
| `activate()` | `activating` | No-op, return current state |
| `activate()` | `online` | No-op, return current state |
| `activate()` | `busy` | No-op, return current state |
| `activate()` | `error` | Retry → `activating` |
| `suspend()` | `offline` | No-op |
| `suspend()` | `activating` | Cancel, cleanup → `offline` |
| `suspend()` | `online` | Graceful shutdown → `suspending` |
| `suspend()` | `busy` | Wait for completion, then shutdown |
| `suspend()` | `suspending` | No-op |

### Rate Limit Handling

Platform APIs may enforce rate limits (e.g., Fly.io: 1 req/s per action). Rate limit errors during idempotent operations SHOULD be handled transparently by the runtime with exponential backoff.

The spec defines *semantic* guarantees (idempotent behavior). The runtime handles *mechanism* (retry/backoff). Callers should not observe rate limit errors for operations that would be no-ops.

---

## 3. Runtime Interface

All runtimes implement the `AgentRuntime` interface. This is the **only** interface the backend uses to manage agent containers.

```typescript
interface AgentRuntime {
  /**
   * Activate an agent by starting its container.
   * Idempotent: returns current state if already activating/online.
   */
  activate(options: ActivateOptions): Promise<AgentRuntimeState>;

  /**
   * Send a message to an online agent's container.
   * Throws if agent is not online.
   */
  sendMessage(agentId: string, message: AgentMessage): Promise<void>;

  /**
   * Suspend an agent by stopping its container.
   * Idempotent: no-op if already offline/suspending.
   */
  suspend(agentId: string, reason?: string): Promise<void>;

  /**
   * Get current runtime state for an agent.
   * Returns null if agent has no runtime state (never activated in this runtime).
   */
  getState(agentId: string): AgentRuntimeState | null;

  /**
   * Check if an agent is currently online.
   */
  isOnline(agentId: string): boolean;

  /**
   * Get all currently online agents.
   */
  getAllOnline(): AgentRuntimeState[];

  /**
   * Graceful shutdown — suspend all agents.
   */
  shutdown(): Promise<void>;
}
```

### Activate Options

```typescript
interface ActivateOptions {
  // Agent identity
  agentId: string;             // Format: {spaceId}:{channelId}:{callsign}

  // Authentication
  authToken: string;           // For container ↔ backend auth

  // Agent configuration (optional)
  systemPrompt?: string;       // Initial system prompt
  mcpServers?: McpServerConfig[];

  // Networking (optional, runtime may ignore)
  tunnelHash?: string;
  tunnelServerUrl?: string;
}
```

**Activation is fire-and-forget.** The `activate()` call returns immediately with `activating` status. The container will call back via `/agents/checkin` when ready, at which point the backend transitions the agent to `online` and broadcasts `agent_state: online` via WebSocket.

This design fits serverless/Lambda deployments where blocking waits are not appropriate. Callers needing confirmation of online status should listen for the WebSocket broadcast.

### Agent Runtime State

```typescript
interface AgentRuntimeState {
  // Identity
  agentId: string;             // Canonical format: {spaceId}:{channelId}:{callsign}

  // Container info (null if offline)
  container: ContainerInfo | null;

  // Status
  status: AgentStatus;

  // Routing (null if not online)
  endpoint: string | null;
  routeHints: Record<string, string> | null;

  // Timestamps
  activatedAt: string | null;  // ISO 8601, null if never activated
  lastActivity: string;        // ISO 8601
}

type AgentStatus = 'offline' | 'activating' | 'online' | 'busy' | 'suspending' | 'error';
```

### Agent Message

```typescript
interface AgentMessage {
  content: string;
  systemPrompt?: string;
  // Future: attachments, metadata, etc.
}
```

---

## 4. Runtime Implementation Contract

Runtimes MUST implement the `AgentRuntime` interface and adhere to these contracts:

### Container Lifecycle

1. **Activation Flow:**
   ```
   activate() called
     → Create container with required env vars
     → Set state to 'activating'
     → Return immediately (fire-and-forget)
     → Container starts, calls /agents/checkin
     → Backend updates state to 'online'
   ```

2. **Suspension Flow:**
   ```
   suspend() called
     → Set state to 'suspending'
     → Send POST /shutdown to container
     → Stop/delete container
     → Set state to 'offline'
     → Clear endpoint and routeHints
   ```

### Persistence Requirement

**When an agent is activated, its container MUST have access to the same filesystem state from previous activations, from the agent's point of view.**

The agent identified by `{spaceId}:{channelId}:{callsign}` sees a consistent working directory across suspend/activate cycles. The runtime may achieve this through any mechanism:
- Persistent volumes (Docker, Fly.io)
- Snapshot/restore from object storage (S3, GCS)
- Network-attached storage
- Copy-on-write filesystem layers

The implementation is runtime-specific and outside scope of this spec. What matters is the agent's observable behavior: files written in one session are available in the next.

### Required Environment Variables

Runtimes MUST inject these environment variables into containers:

| Variable | Source | Description |
|----------|--------|-------------|
| `CAST_API_URL` | Runtime config | Backend API URL |
| `CAST_AGENT_ID` | `options.agentId` | Agent identity (`{spaceId}:{channelId}:{callsign}`) |
| `CAST_AUTH_TOKEN` | `options.authToken` | Authentication token |
| `CAST_CALLBACK_URL` | Runtime-computed | Full URL where container is reachable |
| `CAST_ROUTE_HINTS` | Runtime-computed | JSON map of routing headers (if needed) |
| `ANTHROPIC_API_KEY` | Runtime config | API key for Claude |

Containers can decompose `CAST_AGENT_ID` using `parseAgentId()` if they need individual components.

### Runtime-Specific Callback Configuration

| Runtime | `CAST_CALLBACK_URL` | `CAST_ROUTE_HINTS` |
|---------|---------------------|---------------------|
| Docker | `http://host.docker.internal:{port}` | (not set) |
| Fargate | `http://{publicIp}:{port}` | (not set) |
| Fly.io | `https://{appName}.fly.dev` | `{"fly-force-instance-id":"{machineId}"}` |

**Container code is platform-agnostic.** It reads `CAST_CALLBACK_URL` and `CAST_ROUTE_HINTS` from environment and echoes them in checkin. No platform detection required.

**Note on `routeHints`:** This is an opaque JSON object. The backend stores it from checkin and spreads it as HTTP headers when pushing messages to containers. The backend does NOT interpret the contents — it's a pass-through mechanism. Each runtime constructs hints appropriate for its platform (e.g., Fly.io uses `fly-force-instance-id` header for instance routing). For runtimes that don't need routing hints (Docker), this field is `null` or omitted.

---

## 5. Container HTTP API

Containers MUST expose these endpoints on port 8080 (configurable via `PORT` env var).

### POST /message

Receive a message to process.

**Request:**
```json
{
  "content": "string - message content",
  "agentId": "string - {spaceId}:{channelId}:{callsign}",
  "systemPrompt": "string (optional)"
}
```

**Headers:**
- `Authorization: Bearer {authToken}`
- Additional headers from `routeHints` (e.g., `fly-force-instance-id: abc123`)

**Response:**
- `202 Accepted` — Message queued
- `401 Unauthorized` — Invalid token
- `429 Too Many Requests` — Backpressure (backend retries with backoff)
- `503 Service Unavailable` — Shutting down (treat as push failure)

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy|processing|shutting_down",
  "agentId": "string",
  "idleMs": 12345,
  "queueLength": 0,
  "uptime": 123.45
}
```

### POST /shutdown

Request graceful shutdown.

**Response:**
```json
{
  "status": "shutting_down"
}
```

---

## 6. Backend HTTP API (Container Callbacks)

### POST /agents/checkin

**Purpose:** Register container as ready.

**When:** Once at startup, after HTTP server is listening.

**Request:**
```json
{
  "protocolVersion": "3.0",
  "agentId": "string - {spaceId}:{channelId}:{callsign}",
  "endpoint": "string - from CAST_CALLBACK_URL",
  "routeHints": { "header": "value" },
  "capabilities": ["route-hints"]
}
```

**Validation:**
- `protocolVersion` — REQUIRED, must be "3.0". **Reject with 400 Bad Request if missing or unrecognized.**
- `agentId` — REQUIRED, must match format `{spaceId}:{channelId}:{callsign}`
- `endpoint` — REQUIRED

**Backend Behavior:**
1. Compute `agentId` from `{spaceId}:{channelId}:{callsign}`
2. Validate agent exists in roster
3. Store `endpoint` and `routeHints`
4. Set status to `online`
5. Broadcast `agent_state: online` via WebSocket
6. Deliver pending messages

**Response:**
```json
{
  "ok": true,
  "agentId": "space1:channel1:fox",
  "delivered": 2
}
```

### POST /agents/heartbeat

**Purpose:** Liveness signal.

**When:** Every 30 seconds.

**Request:**
```json
{
  "agentId": "string - {spaceId}:{channelId}:{callsign}"
}
```

**Note:** `endpoint` is NOT allowed in heartbeat. **Reject with 400 Bad Request if present.** Callback URL is immutable after checkin — this prevents bugs where containers accidentally overwrite routing configuration.

**Backend Behavior:**
1. Update `lastHeartbeat`
2. Broadcast `agent_state: online`

**Staleness:** Agent considered offline if no heartbeat for 60 seconds.

### GET /agents/status/:agentId

**Purpose:** Check agent status.

**Note:** `agentId` in path is URL-encoded (colons become `%3A`), e.g., `/agents/status/space1%3Achannel1%3Afox`

**Response:**
```json
{
  "agentId": "space1:channel1:fox",
  "status": "online",
  "endpoint": "https://...",
  "lastActivity": "2026-01-11T09:00:00Z"
}
```

---

## 7. Shared Code Architecture

To maximize code sharing, the protocol defines these shared modules that all runtimes MUST use:

### 7.1 Identity Utilities

```typescript
// @cast/protocol/identity.ts
export interface AgentId {
  spaceId: string;
  channelId: string;
  callsign: string;
}

export function formatAgentId(id: AgentId): string;
export function parseAgentId(agentId: string): AgentId;
export function validateAgentId(agentId: string): boolean;
```

### 7.2 Auth Token Generation

```typescript
// @cast/protocol/auth.ts
export function generateContainerToken(agentId: string, secret: string): string;
export function verifyContainerToken(token: string, secret: string): AgentId | null;
```

### 7.3 State Machine

```typescript
// @cast/protocol/state-machine.ts
export type AgentStatus = 'offline' | 'activating' | 'online' | 'busy' | 'suspending' | 'error';

export interface StateTransition {
  from: AgentStatus;
  event: string;
  to: AgentStatus;
  guard?: () => boolean;
}

export const TRANSITIONS: StateTransition[];

export function canTransition(from: AgentStatus, event: string): AgentStatus | null;
export function validateTransition(from: AgentStatus, to: AgentStatus): boolean;
```

### 7.4 Base Runtime Class

```typescript
// @cast/protocol/base-runtime.ts
export abstract class BaseRuntime implements AgentRuntime {
  // Shared implementations
  protected buildEnvVars(options: ActivateOptions): Record<string, string>;
  protected validateState(agentId: string, expectedStatus: AgentStatus[]): void;

  // Abstract methods for runtime-specific logic
  protected abstract createContainer(options: ActivateOptions): Promise<ContainerInfo>;
  protected abstract destroyContainer(containerId: string): Promise<void>;
  protected abstract getContainerHealth(containerId: string): Promise<boolean>;
  protected abstract computeCallbackUrl(containerId: string): string;
  protected abstract computeRouteHints(containerId: string): Record<string, string> | null;
}
```

This architecture ensures:
- **Identity handling is consistent** — All runtimes use the same formatting/parsing
- **State transitions are validated** — Invalid transitions are caught early
- **Common logic is shared** — Env var construction, token generation, etc.
- **Runtime-specific code is isolated** — Only container creation/destruction varies

---

## 8. Error Handling

### Container Push Failure

1. Clear `endpoint` and `routeHints`
2. Set status to `offline`
3. Broadcast `agent_state: offline`
4. Message becomes pending, delivered on next activation

### Activation Timeout

If no checkin within 180 seconds:
1. Set status to `error`
2. Log diagnostic information
3. Runtime may attempt container cleanup

### Stale Heartbeat

If no heartbeat within 60 seconds:
1. Set status to `offline`
2. Clear routing info
3. Next message triggers fresh activation

### Graceful Shutdown

On SIGTERM:
1. Stop heartbeat loop
2. Return 503 for new messages
3. Complete in-flight work (up to 30s)
4. Exit

---

## 9. Roster Schema (v3.0)

```sql
CREATE TABLE agent_roster (
  -- Identity (primary key is composite)
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  callsign TEXT NOT NULL,

  -- Computed for convenience
  agent_id TEXT GENERATED ALWAYS AS (space_id || ':' || channel_id || ':' || callsign) STORED,

  -- Runtime state
  status TEXT NOT NULL DEFAULT 'offline',
  container_id TEXT,
  runtime TEXT,

  -- Routing
  endpoint TEXT,
  route_hints JSONB,

  -- Protocol
  protocol_version TEXT,
  capabilities TEXT[],

  -- Timestamps
  activated_at TIMESTAMPTZ,
  last_heartbeat TIMESTAMPTZ,
  last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Message tracking
  readmark TEXT,

  PRIMARY KEY (space_id, channel_id, callsign)
);

-- Index for fast online lookups
CREATE INDEX idx_roster_status ON agent_roster(status) WHERE status = 'online';

-- Index for space-scoped queries
CREATE INDEX idx_roster_space ON agent_roster(space_id);
```

---

## 10. Breaking Changes from v2.0

This is a clean-break release with no backward compatibility. All components (backend, runtimes, containers) must be updated together.

1. **Identity model** — `threadId` renamed to `agentId` everywhere (env vars, API fields, types)
2. **Single identity field** — Separate `spaceId`/`channelId`/`callsign` fields consolidated into single `agentId`
3. **Environment variables** — `THREAD_ID`, `CAST_SPACE_ID`, `CAST_CHANNEL_ID`, `CAST_CALLSIGN` → single `CAST_AGENT_ID`
4. **State names** — `starting`→`activating`, `running`→`online`, `stopping`→`suspending`, `stopped`→`offline`
5. **Status endpoint** — Path simplified to `/agents/status/:agentId` (URL-encoded)

---

## 11. Future Considerations

### Short-term
- [ ] Request ID tracking across container/backend
- [ ] `dynamic-callback` capability for endpoint updates via heartbeat
- [ ] Structured error responses with error codes

### Long-term
- [ ] WebSocket transport for lower latency
- [ ] Container-to-container communication
- [ ] Multi-region routing with failover
- [ ] Agent hibernation (persist full state, not just filesystem)

---

## Implementation

- **DockerRuntime**: `backend/packages/runtime/src/docker-orchestrator.ts`
- **FlyRuntime**: `backend/packages/runtime/src/fly-runtime.ts`
- **Container server**: `agents/sandbox/src/server.ts`
- **Checkin handler**: `backend/packages/server/src/handlers/checkin.ts`
