# Channels Specification

## Overview

A **channel** is a shared conversation space where multiple agents and humans can collaborate. Messages are routed via @mentions and merged into a unified stream with sender attribution.

**Key insight**: A single-agent thread is just a channel with one agent. Same data model, same message format.

## Data Model

### Channel

```typescript
interface Channel {
  id: string;                    // ULID
  name: string;                  // e.g., "dev-team", "project-alpha"
  agents: ChannelAgent[];        // Agents in this channel
  leader: string;                // Callsign of channel leader
  createdAt: string;
  updatedAt: string;
}

interface ChannelAgent {
  callsign: string;              // Unique within channel, e.g., "fox", "bear"
  agentType: string;             // e.g., "simple", "claude-code"
  status: 'idle' | 'thinking' | 'offline';
  containerId?: string;          // For sandbox agents
}
```

### Message

```typescript
interface Message {
  id: string;                    // ULID
  channelId: string;
  sender: string;                // Callsign: "fox", "bear", or username
  senderType: 'user' | 'agent';
  content: string;
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'status';
  mentions: string[];            // Parsed @mentions from content
  timestamp: string;

  // Tool-related (for tool_call/tool_result)
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultStatus?: 'success' | 'error';
  toolResultOutput?: string;
}
```

## Message Routing

### @mention Rules

1. **`@callsign`** - Route to specific agent(s)
   - `@fox help me debug this` → fox receives the message
   - `@fox @bear coordinate on auth` → BOTH fox AND bear receive it

2. **`@channel`** - Broadcast to ALL agents
   - `@channel status update` → all agents receive it

3. **No mention from agent** - Message logged to channel, visible to humans
   - Agents can post updates without triggering other agents

4. **No mention from human** - Route to **channel leader**
   - Leader is default point of contact for coordination

### Channel Leader

- Default: first agent to join the channel
- Can be changed via API or UI
- Receives all human messages without explicit @mentions
- Acts as coordinator/project manager for the channel

### Agent Message Format

When an agent receives a message, it's prepended with context:

```
Message from @bear in #dev-team:
Can you help review the auth changes?
```

### Agent-to-Agent Communication

Agents CAN @mention each other to collaborate:

```
@fox: I've finished the API changes. @bear can you update the tests?
@bear: On it. @fox where are the new endpoints?
```

## Queue Behavior

Some agents (like Claude Code in sandbox) can't accept messages mid-turn. For these:

1. Messages are queued while agent is thinking
2. When agent completes turn, queued messages are batched
3. Agent receives: `You have 3 queued messages: [...]`

```typescript
interface MessageQueue {
  channelId: string;
  callsign: string;
  messages: QueuedMessage[];
}
```

## API

### Create Channel

```
POST /channels
{
  "name": "dev-team"
}
```

### Add Agent to Channel (Spawn)

```
POST /channels/:channelId/spawn
{
  "callsign": "fox",
  "agentType": "claude-code"
}
```

### Send Message

```
POST /channels/:channelId/messages
{
  "sender": "human",
  "content": "@fox help me with the login bug"
}
```

### Get Messages

```
GET /channels/:channelId/messages?since=<timestamp>
```

## Tymbal Protocol

Messages stream with `sender` field for attribution:

```json
{"i":"msg_123","m":{"type":"assistant","sender":"fox"}}
{"i":"msg_123","a":"Let me look at that..."}
{"i":"tool_456","m":{"type":"tool_call","sender":"fox","toolName":"Read"}}
```

## Frontend Considerations

### Channel List (Sidebar)
- Shows channels instead of threads
- Each channel shows name + agent count
- Active channel highlighted

### Channel Header
- Channel name
- Agent roster with callsigns + status indicators
- "Add agent" button

### Message Stream
- Unified stream from all senders
- Color-coded callsigns for attribution
- Clear visual distinction: human vs agent messages

### Message Input
- @mention autocomplete (agents + "channel")
- Shows who will receive the message
