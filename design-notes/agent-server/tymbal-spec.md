# Tymbal Protocol Specification (Amended)

**Version**: Tymbal/1.1 (Draft)
**Status**: Amendments to Tymbal/1.0
**Based on**: `design-docs/tymbal/framing.md`, `design-docs/tymbal/messages.md`

This document captures amendments to the Tymbal/1.0 specification based on the current Cikada implementation. It focuses on **new fields and behaviors** not covered in the original spec.

---

## 1. Summary of Amendments

| Area | Tymbal/1.0 | Tymbal/1.1 (Current Implementation) |
|------|------------|-------------------------------------|
| Sender attribution | Not specified | `sender` and `senderType` required in SetFrame values |
| Message types | Generic `type` field | Expanded type enumeration with specific schemas |
| Turn completion | No signal | `agent_complete` message type |
| Metadata in StartFrame | Optional `m` object | `m` should include `sender`, `senderType` |
| Field normalization | N/A | `input` → `args` for tool calls |

---

## 2. Sender Attribution (NEW)

### 2.1 Required Fields in SetFrame Value

All SetFrame values (`v`) MUST include sender attribution:

```typescript
interface SetFrameValue {
  type: MessageType;      // Required: message type discriminator
  sender: string;         // Required: callsign or user ID
  senderType: 'user' | 'agent';  // Required: sender category
  content?: unknown;      // Type-dependent content
  // ... additional type-specific fields
}
```

**Example SetFrame with sender:**
```json
{
  "i": "01JEV5WQ7R1P0S6YB5T2JH9B3X",
  "t": "2026-01-04T14:30:00.000Z",
  "v": {
    "type": "assistant",
    "sender": "fox",
    "senderType": "agent",
    "content": "Hello! How can I help?"
  }
}
```

### 2.2 StartFrame Metadata

StartFrame metadata (`m`) SHOULD also include sender fields for immediate UI rendering:

```json
{"i": "01J...", "m": {"type": "assistant", "sender": "fox", "senderType": "agent"}}
```

### 2.3 Rationale

Sender attribution enables:
- **Multi-agent channels**: Messages attributed to specific agents
- **History scoping**: Filtering messages by sender
- **UI rendering**: Displaying sender identity before content arrives
- **Loop prevention**: Routing logic can exclude sender from recipients

---

## 3. Message Types (EXPANDED)

### 3.1 Type Enumeration

The `type` field discriminates message schemas:

| Type | Direction | Streamable | Description |
|------|-----------|------------|-------------|
| `user` | Human → System | No | Human input message |
| `assistant` | Agent → Human | Yes | Agent text response |
| `tool_call` | Agent → System | No | Tool invocation request |
| `tool_result` | System → Agent | No | Tool execution result |
| `thinking` | Agent internal | Yes | Extended thinking trace |
| `status` | Agent → UI | No | Status update (e.g., "Searching...") |
| `error` | Agent → Human | No | Error message |
| `agent_complete` | Agent → System | No | Turn completion signal |
| `structured_ask` | Agent → Human | No | Form/question for human |

### 3.2 Type-Specific Schemas

#### `user` / `assistant`
```json
{
  "type": "user",
  "sender": "simen",
  "senderType": "user",
  "content": "What's the weather?"
}
```

#### `tool_call`
```json
{
  "type": "tool_call",
  "sender": "fox",
  "senderType": "agent",
  "id": "call_abc123",
  "name": "get_weather",
  "args": {"location": "San Francisco"}
}
```

**Note**: The field is `args`, not `input`. The TymbalFrameHandler normalizes `input` → `args` for compatibility with Anthropic SDK output.

#### `tool_result`
```json
{
  "type": "tool_result",
  "sender": "fox",
  "senderType": "agent",
  "call_id": "call_abc123",
  "name": "get_weather",
  "content": "72°F, sunny",
  "isError": false
}
```

#### `thinking`
```json
{
  "type": "thinking",
  "sender": "fox",
  "senderType": "agent",
  "content": "I need to consider the user's location..."
}
```

#### `status`
```json
{
  "type": "status",
  "sender": "fox",
  "senderType": "agent",
  "content": "Searching the web..."
}
```

#### `error`
```json
{
  "type": "error",
  "sender": "fox",
  "senderType": "agent",
  "content": "Failed to execute tool: permission denied"
}
```

#### `agent_complete` (Turn Completion)
```json
{
  "type": "agent_complete",
  "sender": "fox",
  "senderType": "agent",
  "status": "success",
  "result": "Task completed successfully"
}
```

Or on error:
```json
{
  "type": "agent_complete",
  "sender": "fox",
  "senderType": "agent",
  "status": "error",
  "message": "Rate limit exceeded"
}
```

---

## 4. Turn Completion Signal (NEW)

### 4.1 Purpose

The `agent_complete` message type signals that an agent has finished processing a turn. This enables:
- **UI state management**: Hide typing indicators, enable input
- **Multi-agent coordination**: Know when to route follow-up messages
- **Cleanup**: Release resources after processing completes

### 4.2 Schema

```typescript
interface AgentCompleteValue {
  type: 'agent_complete';
  sender: string;
  senderType: 'agent';
  status: 'success' | 'error';
  result?: string;   // On success: final output summary
  message?: string;  // On error: error description
}
```

### 4.3 Emission Rules

- MUST be emitted once per agent turn
- MUST be the final frame for a turn (after all tool cycles complete)
- Is NOT persisted to message history (metadata only)
- SHOULD trigger @mention routing if `result` contains mentions

### 4.4 Example Turn Sequence

```
← {"i":"01J...001","m":{"type":"assistant","sender":"fox","senderType":"agent"}}
← {"i":"01J...001","a":"Let me check that for you..."}
← {"i":"01J...001","t":"...","v":{"type":"assistant","sender":"fox","senderType":"agent","content":"Let me check that for you..."}}
← {"i":"01J...002","t":"...","v":{"type":"tool_call","sender":"fox","senderType":"agent","id":"t1","name":"search","args":{"q":"weather SF"}}}
← {"i":"01J...003","t":"...","v":{"type":"tool_result","sender":"fox","senderType":"agent","call_id":"t1","content":"72°F sunny","isError":false}}
← {"i":"01J...004","m":{"type":"assistant","sender":"fox","senderType":"agent"}}
← {"i":"01J...004","a":"The weather in SF is 72°F and sunny!"}
← {"i":"01J...004","t":"...","v":{"type":"assistant","sender":"fox","senderType":"agent","content":"The weather in SF is 72°F and sunny!"}}
← {"i":"01J...005","t":"...","v":{"type":"agent_complete","sender":"fox","senderType":"agent","status":"success","result":"Weather lookup complete"}}
```

---

## 5. Frame Handling Rules (AMENDED)

### 5.1 Broadcast vs Persist vs Route

| Frame | Broadcast | Persist | Route @mentions |
|-------|-----------|---------|-----------------|
| StartFrame | ✅ | ❌ | ❌ |
| AppendFrame | ✅ | ❌ | ❌ |
| SetFrame (`assistant`) | ✅ | ✅ | ✅ |
| SetFrame (`tool_call`) | ✅ | ✅ | ❌ |
| SetFrame (`tool_result`) | ✅ | ✅ | ❌ |
| SetFrame (`agent_complete`) | ✅ | ❌ | ✅ (result field) |
| SetFrame (other) | ✅ | ✅ | ❌ |
| ResetFrame | ✅ | ✅ (delete) | ❌ |

### 5.2 Field Normalization

The TymbalFrameHandler normalizes incoming frames:
- `input` → `args` for `tool_call` type (Anthropic SDK compatibility)

Implementation reference: `packages/core/src/tymbal/handler.ts:91-98`

---

## 6. ArtifactFrame (NEW)

### 6.1 Purpose

Broadcast artifact changes to WebSocket clients for real-time board updates.

### 6.2 Schema

ArtifactFrames use SetFrame structure with a synthetic message ID:

```json
{
  "i": "artifact:my-doc",
  "t": "2026-01-04T10:00:00.000Z",
  "v": {
    "artifact": {
      "action": "created" | "updated" | "archived",
      "channelId": "channel-123",
      "payload": {
        "slug": "my-doc",
        "type": "doc",
        "title": "My Document",
        "tldr": "A brief summary",
        "status": "published",
        "path": "/channel-123/my-doc",
        "assignees": ["fox", "bear"]
      }
    }
  }
}
```

### 6.3 Notes

- Uses SetFrame structure with `i` = `artifact:${slug}`
- Action values are past tense: `created`, `updated`, `archived`
- Not persisted to message history
- Used for real-time UI updates only

Implementation reference: `handlers/src/artifacts/handlers.ts:32`

---

## 7. Implementation References

| Component | File | Description |
|-----------|------|-------------|
| Frame types | `packages/core/src/tymbal/frames.ts` | TypeScript interfaces |
| Frame parser | `packages/core/src/tymbal/parser.ts` | JSON parsing + validation |
| Frame handler | `packages/core/src/tymbal/handler.ts` | Broadcast/persist/route |
| Frame builders | `packages/core/src/tymbal/builders.ts` | Helper functions |
| Message types | `packages/core/src/cikada/channels.ts:191-202` | StoredMessageType enum |

---

## 8. Migration Notes

### 8.1 From Tymbal/1.0

Existing implementations should:
1. Add `sender` and `senderType` to all SetFrame values
2. Update StartFrame metadata to include sender fields
3. Handle new message types (`tool_call`, `tool_result`, `agent_complete`, etc.)
4. Implement normalization for `input` → `args`
5. Add ArtifactFrame handling if supporting real-time board updates

### 8.2 Backwards Compatibility

- Receivers SHOULD accept SetFrames without `sender`/`senderType` for legacy support
- Default `senderType` to `'agent'` if missing
- Default `sender` to `'unknown'` if missing

---

## 9. Sync and State Recovery

### 9.1 Recommended Client Flow

For robust state management, clients should use **sync frames for state recovery** combined with **realtime streaming** for new messages:

```
1. Connect WebSocket to /channels/:channelId/stream
2. Send sync request: {"request": "sync", "since": "<last-known-timestamp>"}
3. Process SetFrames from sync response (historical messages)
4. Continue receiving realtime frames (Start/Append/Set)
5. On disconnect: reconnect and sync from last-seen timestamp
```

### 9.2 Sync vs REST Messages Endpoint

| Approach | Use Case | Pros | Cons |
|----------|----------|------|------|
| **Sync frame** | State recovery, reconnection | Realtime handover, no gap | Requires WebSocket |
| **GET /messages** | Initial load, pagination | Works without WS, pagination | May miss in-flight messages |

**Recommendation**: Use sync frames when WebSocket is available. Fall back to REST endpoint for initial load if WebSocket connection is delayed.

### 9.3 Sync Request Schema

```json
{"request": "sync"}                    // Full history
{"request": "sync", "since": "..."}    // Incremental from timestamp
```

**Server Response**: SetFrames for all complete messages matching the query, ordered by ULID.

### 9.4 Handling In-Flight Messages

If an agent is currently streaming when a client connects:
1. Sync response includes all **complete** messages only
2. Client may miss in-progress Start/Append frames
3. When agent completes, SetFrame arrives with full content
4. Client should accept SetFrames for unknown message IDs (late-join safe)

Implementation reference: `packages/server/src/websocket.ts:168-185`

---

## 10. Client Disconnect Behavior

### 10.1 Agent Execution Independence

**Key finding**: Agent execution is **independent of WebSocket connections**.

When a client disconnects:
- WebSocket connection is removed from broadcast set
- Agent processing **continues to completion**
- Frames are persisted via `TymbalFrameHandler.handleFrame()` **regardless of listeners**
- @mention routing continues to trigger other agents

### 10.2 Message Persistence Guarantee

The `TymbalFrameHandler` ensures all SetFrames are persisted:

```typescript
// ALWAYS broadcast for streaming UX (may have no listeners)
await broadcast(channelId, normalizedFrame);

// Persist to storage (independent of broadcast success)
await persistSetFrame(storage, spaceId, channelId, normalizedSetFrame);
```

**Result**: Messages are captured even if no clients are connected.

### 10.3 Reconnection Recovery

When a client reconnects:
1. Send sync request with last-seen timestamp
2. Receive all messages persisted during disconnection
3. Resume realtime streaming

**No data loss** occurs due to client disconnect.

### 10.4 Durable Agent Specifics

For durable agents (`engine: 'durable'`):
- Execution state is checkpointed to SQLite
- Agent can resume from checkpoint after server restart
- Independent of both client WebSocket and server process lifecycle

Implementation reference: `packages/server/src/agent-manager.ts:771-850`

---

## 11. Open Questions

1. **turnId field**: Documented in StoredMessage but not consistently used in frames. Consider adding to frame metadata for explicit turn grouping.

2. **Error recovery**: No retry mechanism for failed frame delivery. Consider adding acknowledgment frames.

3. **Presence/typing**: No standard way to indicate agent is typing without starting a message. Consider dedicated presence frames.

---

## Appendix: Full Frame Examples

### A.1 Complete Assistant Turn

```ndjson
{"i":"01J001","m":{"type":"assistant","sender":"fox","senderType":"agent"}}
{"i":"01J001","a":"Hello! "}
{"i":"01J001","a":"How can I help you today?"}
{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":{"type":"assistant","sender":"fox","senderType":"agent","content":"Hello! How can I help you today?"}}
{"i":"01J002","t":"2026-01-04T10:00:00.100Z","v":{"type":"agent_complete","sender":"fox","senderType":"agent","status":"success"}}
```

### A.2 Tool Use Turn

```ndjson
{"i":"01J001","m":{"type":"assistant","sender":"fox","senderType":"agent"}}
{"i":"01J001","a":"Let me search for that..."}
{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":{"type":"assistant","sender":"fox","senderType":"agent","content":"Let me search for that..."}}
{"i":"01J002","t":"2026-01-04T10:00:00.100Z","v":{"type":"tool_call","sender":"fox","senderType":"agent","id":"tc1","name":"web_search","args":{"query":"weather"}}}
{"i":"01J003","t":"2026-01-04T10:00:01.000Z","v":{"type":"tool_result","sender":"fox","senderType":"agent","call_id":"tc1","name":"web_search","content":"72°F sunny","isError":false}}
{"i":"01J004","m":{"type":"assistant","sender":"fox","senderType":"agent"}}
{"i":"01J004","a":"The weather is 72°F and sunny!"}
{"i":"01J004","t":"2026-01-04T10:00:01.500Z","v":{"type":"assistant","sender":"fox","senderType":"agent","content":"The weather is 72°F and sunny!"}}
{"i":"01J005","t":"2026-01-04T10:00:01.600Z","v":{"type":"agent_complete","sender":"fox","senderType":"agent","status":"success"}}
```

### A.3 Error Turn

```ndjson
{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":{"type":"error","sender":"fox","senderType":"agent","content":"Failed to connect to API"}}
{"i":"01J002","t":"2026-01-04T10:00:00.100Z","v":{"type":"agent_complete","sender":"fox","senderType":"agent","status":"error","message":"API connection failed"}}
```

