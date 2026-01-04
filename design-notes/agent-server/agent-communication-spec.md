# Agent Communication Specification

## Overview

The Cikada platform uses a **message-centric architecture** where agents communicate through channels using the **Tymbal streaming protocol**. Messages are routed based on **@mentions**, and conversation history is scoped per-agent based on message addressing.

---

## 1. Message Data Model

### 1.1 StoredMessage

Messages are persisted with the following schema:

```typescript
interface StoredMessage {
  id: string;              // ULID - provides ordering
  channelId: string;       // Target channel
  sender: string;          // Who sent (callsign or user ID)
  senderType: 'user' | 'agent';
  type: StoredMessageType;
  content: unknown;        // Shape varies by type
  timestamp: string;       // ISO 8601
  isComplete: boolean;     // For streaming messages
  addressedAgents?: string[];  // Routing targets
  turnId?: string;         // Groups messages from one agentic loop
}
```

### 1.2 Message Types

| Type | Direction | Streamable | Content Shape |
|------|-----------|------------|---------------|
| `user` | Human → System | No | `string` |
| `assistant` | Agent → Human/Agents | Yes | `string` |
| `tool_call` | Agent → System | Yes | `{id, name, args}` |
| `tool_result` | System → Agent | No | `{call_id, name, content, isError}` |
| `thinking` | Agent internal | Yes | `string` |
| `status` | Agent → UI | No | `string` |
| `error` | Agent → Human | No | `string` |
| `agent_complete` | Agent → System | No | `{agentId, result}` |
| `structured_ask` | Agent → Human | No | Form definition |
| `agent_message` | Agent → Agent | No | `{senderId, payload, replyTo?}` |
| `attachment` | Any → Channel | No | Attachment metadata |

### 1.3 addressedAgents Field

The `addressedAgents` field determines which agents should see a message in their conversation history:

- `["fox", "bear"]` → Routed to specific agents
- `["channel"]` → Broadcast to all agents
- `[]` or `undefined` → Logged but not routed

---

## 2. Tymbal Streaming Protocol

### 2.1 Frame Types

Tymbal uses **NDJSON** (newline-delimited JSON) for real-time streaming.

**StartFrame** - Declares a message exists:
```json
{"i": "01J...", "m": {"type": "assistant", "sender": "fox"}}
```

**AppendFrame** - Progressive text streaming:
```json
{"i": "01J...", "a": "Hello "}
```

**SetFrame** - Finalizes message with complete value:
```json
{"i": "01J...", "t": "2026-01-04T...", "v": {"type": "assistant", "sender": "fox", "content": "Hello world"}}
```

**ResetFrame** - Deletes a message:
```json
{"i": "01J...", "v": null}
```

### 2.2 Streaming Flow

```
Agent starts    → StartFrame    → UI shows typing indicator
Agent streams   → AppendFrame+  → UI appends text progressively
Agent finishes  → SetFrame      → Storage persists, @mentions route
```

### 2.3 Frame Routing Rules

| Frame Type | WebSocket Broadcast | Storage Persist | @mention Routing |
|------------|---------------------|-----------------|------------------|
| StartFrame | ✅ | ❌ | ❌ |
| AppendFrame | ✅ | ❌ | ❌ |
| SetFrame | ✅ | ✅ | ✅ |
| ResetFrame | ✅ | ✅ (delete) | ❌ |

---

## 3. Message Sending

### 3.1 HTTP API

**Endpoint:** `POST /channels/:channelId/messages`

**Request:**
```typescript
interface SendMessageRequest {
  content: string;
  sender: string;
  senderType: 'user' | 'agent';
}
```

**Response:**
```typescript
interface SendMessageResponse {
  messageId: string;  // ULID
  timestamp: string;  // ISO 8601
}
```

### 3.2 Send Flow

1. Server generates ULID for message
2. Parses @mentions from content
3. Determines `addressedAgents`:
   - If `@channel` → `["channel"]`
   - If explicit @mentions → `["fox", "bear"]`
   - If human sender, no mentions → Route to channel leader or first agent
4. Persists to storage
5. Broadcasts Tymbal SetFrame to WebSocket clients
6. Triggers async `agentManager.routeMessage()`

**Code reference:** `packages/server/src/http.ts:841-918`

---

## 4. Message Routing

### 4.1 @mention System

Messages are routed based on @mentions in content:

- `@fox` → Routes to agent with callsign "fox"
- `@channel` → Broadcasts to all agents in channel
- No mentions from human → Routes to channel leader (or first agent)
- No mentions from agent → Not routed (prevents loops)

### 4.2 Routing Logic

```typescript
async routeMessage(spaceId, channelId, sender, content): Promise<void> {
  // Skip routing for 'unknown' senders (e.g., tool_result frames)
  if (sender === 'unknown') return;
  
  const { mentions, isChannelBroadcast } = parseMentions(content);
  const agentRosterEntries = roster.filter(r => 
    r.type === 'agent' && r.id !== sender
  );
  
  let targetAgents = [];
  
  if (isChannelBroadcast) {
    targetAgents = agentRosterEntries;  // All agents
  } else if (mentions.length > 0) {
    targetAgents = agentRosterEntries.filter(r => 
      mentions.includes(r.id.toLowerCase())
    );
  } else if (!senderIsAgent) {
    // Human with no mentions → channel leader
    targetAgents = [leaderEntry ?? agentRosterEntries[0]];
  }
  // Agent with no mentions → no routing (prevents loops)
  
  for (const entry of targetAgents) {
    await spawn(entry);
    await sendToAgent(agent, sender, content);
  }
}
```

**Code reference:** `packages/server/src/agent-manager.ts:512-580`

### 4.3 Auto-Spawn Behavior

Agents are auto-spawned from roster when:
- They receive a routed message
- They're not already running

---

## 5. Response Streaming

### 5.1 Agent Response Flow

When an agent receives a message:

1. **State transition:** `idle` → `thinking`
2. **Driver selection** based on agent config:
   - `engine: 'claude-code'` → Docker sandbox
   - `engine: 'reactive'` → Reactive driver with MCP
   - Default → Standard driver or durable driver
3. **Streaming:** Agent emits Tymbal frames via broadcast function
4. **Persistence:** SetFrames trigger storage save
5. **Routing:** Assistant messages trigger @mention routing for follow-up
6. **State transition:** `thinking` → `idle`

### 5.2 TymbalFrameHandler

Centralized handler for all agent frames:

```typescript
async handleFrame(spaceId, channelId, frame): Promise<void> {
  // Parse and normalize (input → args)
  const parsed = parseFrame(frame);
  
  // ALWAYS broadcast for streaming UX
  await broadcast(channelId, normalizedFrame);
  
  if (isSetFrame(parsed)) {
    // Persist to storage
    await persistSetFrame(storage, spaceId, channelId, parsed);
    
    // Route @mentions for assistant messages
    if (parsed.v.type === 'assistant') {
      await routeMessage(spaceId, channelId, parsed.v.sender, parsed.v.content);
    }
  }
  
  if (isResetFrame(parsed)) {
    await storage.deleteMessage(spaceId, parsed.i);
  }
}
```

**Code reference:** `packages/core/src/tymbal/handler.ts`

### 5.3 Docker Container Bridge

For `claude-code` agents running in Docker:

1. Container runs Claude Code CLI with `--output-format stream-json`
2. `TymbalBridge` translates CLI events to Tymbal frames
3. Frames POSTed to `/thread/:threadId/tymbal` endpoint
4. Server routes through TymbalFrameHandler

**Code reference:** `packages/fargate-runtime/wrapper/tymbal-bridge.ts`

---

## 6. Conversation History

### 6.1 Agent History Scoping

Each agent sees only messages relevant to them:

```sql
SELECT * FROM messages
WHERE space_id = ? AND channel_id = ?
  AND timestamp >= ?  -- Agent's joinedAt (instance start)
  AND (
    -- Message was addressed to this agent
    EXISTS (SELECT 1 FROM json_each(addressed_agents) WHERE value = ?)
    -- Or it was a broadcast
    OR EXISTS (SELECT 1 FROM json_each(addressed_agents) WHERE value = 'channel')
    -- Or agent sent it
    OR sender = ?
  )
ORDER BY timestamp ASC
```

**Code reference:** `packages/storage/src/sqlite/index.ts:453-486`

### 6.2 History → LLM Format Conversion

Stored messages are converted to Anthropic API format using **positional grouping by sender**:

```typescript
function convertToAnthropicFormat(messages: StoredMessage[]): Message[] {
  const pendingAssistant = new Map<string, Message>();
  
  for (const msg of messages) {
    switch (msg.type) {
      case 'user':
        result.push({ role: 'user', content: msg.content });
        break;
        
      case 'assistant':
        const assistantMsg = { role: 'assistant', content: [...] };
        result.push(assistantMsg);
        pendingAssistant.set(msg.sender, assistantMsg);
        break;
        
      case 'tool_call':
        // Attach to most recent assistant message FROM SAME SENDER
        const pending = pendingAssistant.get(msg.sender);
        pending.content.push({ type: 'tool_use', ... });
        break;
        
      case 'tool_result':
        // Tool results become user messages (Anthropic format)
        result.push({ role: 'user', content: [{ type: 'tool_result', ... }] });
        break;
    }
  }
  return result;
}
```

### 6.3 WebSocket Sync

Clients request history via sync frame:

```json
{"request": "sync", "since": "2026-01-04T00:00:00.000Z"}
```

Server responds with SetFrames for all messages since cursor.

**Code reference:** `packages/server/src/websocket.ts:168-185`

---

## 7. API Reference

### 7.1 HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/channels/:id/messages` | Send message |
| GET | `/channels/:id/messages` | Get message history |
| POST | `/channels/:id/tymbal` | Receive Tymbal frame from agent |
| POST | `/channels/:id/structured-asks` | Create structured form |

### 7.2 WebSocket

**Connect:** `ws://host/channels/:channelId/stream`

**Frames:**
- Client → Server: `SyncRequest`
- Server → Client: `SetFrame`, `AppendFrame`, `StartFrame`

### 7.3 Query Parameters (GET /messages)

| Param | Type | Description |
|-------|------|-------------|
| `since` | ULID | Return messages after this ID |
| `before` | ULID | Return messages before this ID |
| `limit` | number | Max messages to return |

---

## 8. Implementation Notes

### 8.1 Field Normalization

The system normalizes tool_call frames:
- `input` → `args` (Anthropic SDK uses `input`, we store as `args`)

### 8.2 ID Generation

- Messages use ULIDs for sortable, unique identifiers
- Client-generated IDs are validated and used as-is (no server reassignment)

### 8.3 Multi-Agent Coordination

- Agents must use @mentions to communicate with each other
- Messages without @mentions from agents are not routed (prevents infinite loops)
- The `sender` field in frames enables proper attribution and history grouping

### 8.4 Rough Spots / Future Improvements

1. **turnId field**: Documented but not consistently used; positional grouping by sender works for now
2. **Error recovery**: No explicit retry mechanism for failed frame delivery
3. **Message ordering**: ULID provides ordering, but no conflict resolution for concurrent messages
4. **Attachment handling**: Attachments are separate from message content, linked by messageId

---

## References

- `packages/core/src/tymbal/` - Frame types, parser, handler
- `packages/core/src/cikada/channels.ts` - StoredMessage, RosterEntry types
- `packages/server/src/http.ts` - HTTP API endpoints
- `packages/server/src/websocket.ts` - WebSocket handling
- `packages/server/src/agent-manager.ts` - Agent lifecycle, routing
- `packages/storage/src/interface.ts` - Storage interface
- `design-docs/tymbal/messages.md` - Tymbal Messages/1.0 spec
- `design-docs/tymbal-streaming-persistence-spec.md` - Architecture spec

