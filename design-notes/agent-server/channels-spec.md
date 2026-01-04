# Channels & Rosters Specification

## Overview

Channels are the primary containers for real-time collaboration in Cikada. Each channel hosts a roster of participants (humans and agents) who communicate via messages and collaborate on artifacts stored in the channel's board.

**Key Design Principle**: Channels are separate from agent runtimes. Agents connect to channels as clients, enabling multiple runtime types (stateless, durable, sandbox) to participate in the same channel.

---

## 1. Channel Data Model

### 1.1 Channel Entity

**Source**: `packages/core/src/cikada/channels.ts:15-48`

```typescript
interface Channel {
  id: string;           // ULID - unique identifier
  spaceId: string;      // Parent space
  name: string;         // Human-readable name
  roster: string[];     // Participant IDs
  leader?: string;      // Callsign of leader (receives unaddressed messages)
  createdAt: string;    // ISO timestamp
  description?: string;
  status: ChannelStatus;      // 'active' | 'archived'
  focusSlug?: string;         // References system.focus artifact
  tagline?: string;           // Short channel label
  mission?: string;           // Channel purpose description
}
```

### 1.2 Channel Status

| Status | Description |
|--------|-------------|
| `active` | Channel is operational, accepts messages |
| `archived` | Soft-deleted, read-only, not listed by default |

### 1.3 Focus Areas

Focus areas are templates stored as `system.focus` artifacts that define default configurations for new channels.

**Source**: `packages/handlers/src/channels/types.ts:90-96`

```typescript
interface FocusProps {
  agents?: string[];           // Agent definition slugs to spawn
  defaultTagline?: string;     // Default tagline if not overridden
  defaultMission?: string;     // Default mission if not overridden
  initialPrompt?: string;      // Message posted when channel created
  leader?: string;             // Default leader callsign
}
```

**Resolution Order** (from `packages/handlers/src/channels/handlers.ts:39-61`):
1. Look up `system.focus` artifact by `focusSlug` in root channel
2. Extract props (agents, tagline, mission, leader, initialPrompt)
3. Apply any overrides provided at channel creation time

---

## 2. Roster System

### 2.1 Roster Entry

**Source**: `packages/core/src/cikada/channels.ts:59-84`

```typescript
interface RosterEntry {
  id: string;                  // Participant identifier (callsign for agents)
  name: string;                // Display name
  type: ParticipantType;       // 'user' | 'agent'
  status: ParticipantStatus;   // 'online' | 'offline' | 'busy'
  joinedAt: string;            // ISO timestamp (serves as instance startTime)
  agentConfig?: AgentConfig;   // Agent-specific config
  systemPrompt?: string;       // Captured at spawn time, immutable
}
```

**Important**: The `joinedAt` timestamp serves as the agent instance's start time. History queries for that agent are scoped to messages **after** this timestamp, ensuring agents don't see messages from before they joined.

### 2.2 Participant Types

| Type | Description |
|------|-------------|
| `user` | Human participant connected via UI |
| `agent` | AI agent (various engines) |

### 2.3 Participant Status

| Status | Description |
|--------|-------------|
| `online` | Connected and available |
| `offline` | Not connected |
| `busy` | Processing a request |

---

## 3. Agent Definitions

### 3.1 Agent Definition Artifact

Agent types are defined as `system.agent` artifacts stored in the root channel.

**Source**: `packages/handlers/src/agents/types.ts:11-19, 66-71`

```typescript
interface ResolvedAgentDefinition {
  slug: string;           // Artifact slug (e.g., 'lead', 'engineer')
  name: string;           // Display name from artifact.title
  content: string;        // System prompt
  engine?: string;        // 'stateless' | 'claude-code' (in scope) | 'durable' | 'reactive' | 'hosted' (deferred)
  model?: string;         // Model override (e.g., 'claude-sonnet-4-20250514')
  agentName?: string;     // Fixed callsign (if defined)
  mcp?: Array<{ slug: string }>;  // MCP server references
}

interface AgentProps {
  engine?: string;
  model?: string;
  agentName?: string;
  mcp?: Array<{ slug: string }>;
}
```

### 3.2 Agent Engines

**Source**: `packages/core/src/cikada/channels.ts:140`

| Engine | Description | Scope |
|--------|-------------|-------|
| `stateless` | Request/response, history reconstructed each turn | **In scope** |
| `claude-code` | Containerized Claude Code CLI with filesystem | **In scope** |
| `durable` | Lambda Durable with checkpointing, zero-cost suspend | *Out of scope* |
| `reactive` | Event-driven, responds to @mentions | *Out of scope* |
| `hosted` | External hosted agent (future) | *Out of scope* |

**Note**: For the reimplementation, only `stateless` and `claude-code` engines are in scope. The `durable`, `reactive`, and `hosted` engines exist in the reference implementation but are deferred.

### 3.3 Agent Configuration

**Source**: `packages/core/src/cikada/channels.ts:120-138`

```typescript
interface AgentConfig {
  agentName?: string;            // Agent definition slug
  engine?: AgentEngine;
  model?: string;
  system?: string;               // System prompt
  maxTokens?: number;
  mcpServers?: McpServerConfig[];
}
```

---

## 4. MCP Server Configuration

Agents can be configured with MCP servers for tool access.

**Source**: `packages/core/src/cikada/channels.ts:94-115`

```typescript
interface McpServerConfig {
  name: string;              // Server name for tool namespacing
  slug?: string;             // Artifact slug (for board-defined servers)
  transport: 'stdio' | 'sse' | 'http';
  // For stdio transport:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // For sse/http transport:
  url?: string;
  headers?: Record<string, string>;
  capabilities?: string;     // Human-readable description
}
```

### 4.1 MCP Server Artifacts

MCP servers can be defined as `system.mcp` artifacts:

```typescript
interface McpProps {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;              // Supports ${ENV_VAR} and {channelId} placeholders
  headers?: Record<string, string>;
  capabilities?: string;
}
```

**URL Placeholders** (from `packages/handlers/src/agents/resolve.ts:71-77`):
- `${ENV_VAR}` - Replaced with environment variable value
- `{channelId}` - Replaced with current channel ID

---

## 5. Agent Resolution

### 5.1 Resolution Order

**Source**: `packages/handlers/src/agents/resolve.ts:110-143`

1. Check channel-local artifacts for agent definition
2. Fall back to root channel if not found or wrong type
3. Return `undefined` if agent definition not found

### 5.2 MCP Config Resolution

**Source**: `packages/handlers/src/agents/resolve.ts:159-209`

1. Look up `system.mcp` artifact by slug
2. Fall back to root channel if not found
3. Resolve environment variables in `env` record
4. Resolve URL placeholders (`${ENV_VAR}`, `{channelId}`)
5. Return resolved config

---

## 6. Channel Lifecycle

### 6.1 Channel Creation Flow

**Source**: `packages/handlers/src/channels/handlers.ts:94-188`

1. **Resolve focus area** (if `focusSlug` provided)
   - Look up `system.focus` artifact in root channel
   - Extract default tagline, mission, agents, leader
   
2. **Create channel record**
   - Generate ULID for channel ID
   - Apply focus defaults with any overrides
   - Set initial status to `active`

3. **Spawn focus agents**
   - For each agent slug in focus:
     - Resolve agent definition from artifacts
     - Resolve MCP server configs
     - Create roster entry with system prompt captured
     - Add to roster storage

4. **Post initial prompt** (if defined in focus)
   - Create system message with initial prompt content

### 6.2 Adding Agents to Channel

**Source**: `packages/handlers/src/channels/handlers.ts:254-328`

1. Validate callsign doesn't already exist in roster
2. Resolve agent definition from artifacts
3. Resolve MCP configs if agent has MCP references
4. Create roster entry:
   ```typescript
   {
     id: callsign,
     name: callsign,
     type: 'agent',
     status: 'online',
     joinedAt: new Date().toISOString(),
     agentConfig: { /* resolved config */ },
     systemPrompt: agentDef.content
   }
   ```
5. Add to roster storage
6. Broadcast `roster.agent_joined` event

### 6.3 Removing Agents from Channel

**Source**: `packages/handlers/src/channels/handlers.ts:338-386`

1. Find agent in roster by callsign
2. Check leader protection (default: cannot remove leader)
3. Remove from roster storage
4. Broadcast `roster.agent_dismissed` event

### 6.4 Channel Archival

Simple status update from `active` to `archived`. Archived channels:
- Not listed by default in channel queries
- Remain readable for history
- No new messages accepted (TODO: verify enforcement)

---

## 7. HTTP API Endpoints

**Base path**: `/channels`

### 7.1 Channel Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/channels` | Create channel |
| `GET` | `/channels` | List channels |
| `GET` | `/channels/:id` | Get channel with roster |
| `DELETE` | `/channels/:id` | Archive channel |

### 7.2 Roster Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/channels/:id/roster` | Add participant |
| `DELETE` | `/channels/:id/roster/:participantId` | Remove participant |

### 7.3 Agent Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/agents` | List available agent types |
| `POST` | `/channels/:id/agents` | Add agent to channel |
| `DELETE` | `/channels/:id/agents/:callsign` | Dismiss agent |

---

## 8. API Request/Response Formats

### 8.1 Create Channel

**Request**: `POST /channels`
```json
{
  "name": "my-channel",
  "description": "Optional description",
  "focusSlug": "open",
  "tagline": "Override tagline",
  "mission": "Override mission"
}
```

**Response**: `201 Created`
```json
{
  "channel": {
    "id": "01HXYZ...",
    "name": "my-channel",
    "status": "active",
    "tagline": "Override tagline",
    "mission": "Override mission",
    "leader": "lead",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### 8.2 Get Channel

**Response**: `GET /channels/:id`
```json
{
  "channel": { /* Channel object */ },
  "roster": [
    {
      "id": "lead",
      "name": "lead",
      "type": "agent",
      "status": "online",
      "joinedAt": "2024-01-01T00:00:00.000Z",
      "agentConfig": {
        "agentName": "lead",
        "engine": "reactive",
        "model": "claude-sonnet-4-20250514"
      }
    }
  ]
}
```

### 8.3 Add Agent

**Request**: `POST /channels/:id/agents`
```json
{
  "agentType": "engineer",
  "callsign": "fox"
}
```

**Response**: `201 Created`
```json
{
  "success": true,
  "agent": {
    "id": "fox",
    "callsign": "fox",
    "agentType": "engineer",
    "status": "idle"
  }
}
```

---

## 9. Storage Interface

**Source**: `packages/storage/src/interface.ts`

### 9.1 Channel Operations

```typescript
interface Storage {
  createChannel(spaceId: string, params: CreateChannelParams): Promise<Channel>;
  getChannel(spaceId: string, channelId: string): Promise<Channel | null>;
  getChannelByName(spaceId: string, name: string): Promise<Channel | null>;
  listChannels(spaceId: string, params?: ListChannelsParams): Promise<Channel[]>;
  updateChannelStatus(spaceId: string, channelId: string, status: ChannelStatus): Promise<void>;
}
```

### 9.2 Roster Operations

```typescript
interface Storage {
  addToRoster(spaceId: string, channelId: string, entry: RosterEntry): Promise<void>;
  removeFromRoster(spaceId: string, channelId: string, participantId: string): Promise<void>;
  getRoster(spaceId: string, channelId: string): Promise<RosterEntry[]>;
  getRosterEntry(spaceId: string, channelId: string, participantId: string): Promise<RosterEntry | null>;
  updateRosterEntry(spaceId: string, channelId: string, participantId: string, update: Partial<RosterEntry>): Promise<void>;
}
```

---

## 10. Broadcast Events

When roster changes occur, events are broadcast to connected clients via WebSocket.

### 10.1 Agent Joined

**Source**: `packages/handlers/src/channels/handlers.ts:311-325`

```json
{
  "i": "agent:fox",
  "t": "2024-01-01T00:00:00.000Z",
  "v": {
    "type": "roster",
    "action": "agent_joined",
    "agent": {
      "callsign": "fox",
      "agentType": "engineer",
      "status": "idle"
    }
  }
}
```

### 10.2 Agent Dismissed

**Source**: `packages/handlers/src/channels/handlers.ts:372-385`

```json
{
  "i": "agent:fox",
  "t": "2024-01-01T00:00:00.000Z",
  "v": {
    "type": "roster",
    "action": "agent_dismissed",
    "agent": {
      "callsign": "fox",
      "agentType": "engineer"
    }
  }
}
```

---

## 11. Seed Data

**Source**: `packages/handlers/src/bootstrap/seed-data.ts`

Default artifacts seeded into root channel:

1. **`open`** (`system.focus`) - Default workspace template
   - Spawns: `lead` agent
   - Tagline: "Open workspace"
   - Mission: "A flexible space for freeform collaboration and exploration."

2. **`board-mcp`** (`system.mcp`) - Board tools for reactive agents
   - Transport: HTTP
   - URL: `${CIKADA_API_URL}/mcp/{channelId}`

3. **`lead`** (`system.agent`) - Primary coordinator agent
   - Engine: `stateless` (reference uses `reactive`, but `stateless` for reimplementation)
   - Model: `claude-sonnet-4-20250514`
   - MCP: `board-mcp`

---

## 12. Implementation Notes & Gaps

### 12.1 Current Implementation

- Channel CRUD operations fully implemented
- Focus area resolution working
- Agent spawning from focus definitions working
- MCP config resolution with env var substitution working
- Roster management with leader protection working
- WebSocket broadcast for roster changes working

### 12.2 Type Inconsistencies Between Packages

**Note**: There are inconsistencies between `@cikada/core` and `@cikada/handlers` type definitions that should be cleaned up:

| Type | `@cikada/core` | `@cikada/handlers` |
|------|----------------|-------------------|
| `ParticipantType` | `'user' \| 'agent'` | `'agent' \| 'human'` |
| `ParticipantStatus` | `'online' \| 'offline' \| 'busy'` | `'online' \| 'offline' \| 'active' \| 'idle'` |

These inconsistencies could cause issues when passing data between packages. Recommend consolidating to a single source of truth.

### 12.3 Potential Improvements

1. **Channel Archival Enforcement**: Currently `archived` is just a status flag. Consider enforcing read-only mode.

2. **Agent Status Updates**: Roster entries have status field but unclear when/how it's updated during agent processing.

3. **Callsign Uniqueness**: Currently validated per-channel. Consider space-wide uniqueness for cross-channel mentions.

4. **Focus Area Inheritance**: Consider allowing channel-local focus overrides vs. always reading from root.

5. **Roster Entry Updates**: `updateRosterEntry` exists in storage interface (`storage/src/interface.ts:207`) but is **not exposed via HTTP API**, limiting the ability to update agent status programmatically. Consider adding `PATCH /channels/:id/roster/:participantId` endpoint.

---

## 13. Code References

| Component | Location |
|-----------|----------|
| Core Channel Types | `packages/core/src/cikada/channels.ts` |
| Handler Types | `packages/handlers/src/channels/types.ts` |
| Channel Handlers | `packages/handlers/src/channels/handlers.ts` |
| Agent Resolution | `packages/handlers/src/agents/resolve.ts` |
| Agent Types | `packages/handlers/src/agents/types.ts` |
| Storage Interface | `packages/storage/src/interface.ts` |
| HTTP Routes | `packages/server/src/http.ts` |
| Seed Data | `packages/handlers/src/bootstrap/seed-data.ts` |
| Local Runtime Channel | `packages/local-runtime/src/channel.ts` |
| Tests | `packages/handlers/src/__tests__/channels.test.ts` |

