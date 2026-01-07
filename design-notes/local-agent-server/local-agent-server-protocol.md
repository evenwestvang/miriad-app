# Local Agent WebSocket Protocol (Stage 1)

Contract between `local-agent-engine` (client) and CAST server (server) for Stage 1.

---

## Endpoint

```
{CAST_WS_HOST}/local-agents/connect
```

Host is config-driven:
- Local dev: `ws://localhost:3234/local-agents/connect`
- Staging: `wss://ws.staging.clanker.is/local-agents/connect`
- Prod: `wss://ws.clanker.is/local-agents/connect`

**Note:** AWS uses separate hosts for HTTP API and WebSocket (e.g., `api.staging.clanker.is` vs `ws.staging.clanker.is`). Local dev uses unified localhost. Config must support distinct `CAST_API_HOST` and `CAST_WS_HOST` values.

No authentication in Stage 1 — trusts localhost.

---

## Connection Flow

```
1. Client connects to WS endpoint
2. Server sends: { type: "connected" }
3. Client sends: { type: "register", channelId, callsign, workspace }
4. Server validates and responds:
   - Success: { type: "registered", callsign, channelId }
   - Error: { type: "error", code, message }
5. Server adds agent to channel roster
6. Client is now ready to receive messages
```

---

## Message Types

### Server → Client (Downstream)

#### `connected`
Sent immediately after WebSocket connection established.

```typescript
{
  type: "connected",
  version: "1"            // protocol version for future evolution
}
```

#### `registered`
Confirms agent registration success.

```typescript
{
  type: "registered",
  callsign: string,
  channelId: string
}
```

#### `message`
A message directed at this agent (someone @mentioned the callsign).

```typescript
{
  type: "message",
  id: string,              // message ID
  channelId: string,
  callsign: string,        // target agent
  content: string,         // message content
  sender: string,          // who sent it
  systemPrompt: string     // agent's system prompt from CAST
}
```

#### `error`
Error response for failed operations.

```typescript
{
  type: "error",
  code: string,            // e.g., "ALREADY_REGISTERED", "CHANNEL_NOT_FOUND"
  message: string          // human-readable description
}
```

**Error codes (Stage 1):**
- `ALREADY_REGISTERED` — callsign already exists in channel
- `CHANNEL_NOT_FOUND` — invalid channelId
- `INVALID_MESSAGE` — malformed message

---

### Client → Server (Upstream)

#### `register`
Register agent in a channel. Must be sent before any other messages.

```typescript
{
  type: "register",
  channelId: string,
  callsign: string,
  workspace: string        // local workspace path (informational, stored for debugging)
}
```

#### `frame`
Tymbal frame for agent output. Follows existing Tymbal protocol.

```typescript
{
  type: "frame",
  channelId: string,
  frame: TymbalFrame
}
```

**TymbalFrame structure:**

```typescript
// Start frame (message begun, no content yet)
{
  i: string,               // ULID message ID
  m: {                     // metadata
    type: "agent",
    sender: string         // callsign
  }
}

// Append frame (streaming content)
{
  i: string,               // same message ID
  a: string                // content to append
}

// Set frame (complete message or update)
{
  i: string,
  t: string,               // ISO timestamp
  v: {                     // complete value
    type: "agent" | "tool_call" | "tool_result" | "error" | "idle",
    sender: string,
    senderType: "agent",
    content?: string,      // text content (for agent)
    name?: string,         // tool name (for tool_call)
    args?: object,         // tool args (for tool_call)
    toolCallId?: string,   // tool use ID (for tool_call, tool_result)
    result?: any,          // tool result (for tool_result)
    isError?: boolean,     // was tool result an error (for tool_result)
    message?: string       // error message (for error)
  }
}

// NOTE: Frame types aligned with existing tymbal-bridge.ts implementation:
// - agent: assistant text responses
// - tool_call: tool invocations
// - tool_result: tool outputs  
// - error: processing errors
// - idle: turn complete signal
```

---

## Lifecycle

### Registration
- Client MUST send `register` message first
- Server MUST respond with `registered` or `error`
- Client MUST NOT send `frame` messages before receiving `registered`

### Message Handling
- Server routes messages to client when someone @mentions the callsign
- Client processes message via Claude Agent SDK
- Client streams Tymbal frames back as SDK produces output

### Disconnect
- On WebSocket close, server removes agent from channel roster
- No explicit "unregister" message needed in Stage 1
- Client can reconnect and re-register

---

## Heartbeat

Stage 1: Rely on WebSocket protocol-level ping/pong (handled by libraries).

No application-level heartbeat. Connection health determined by socket state.

---

## Example Flow

```
Client                                    Server
   |                                         |
   |-------- WS connect ------------------->|
   |<------- { type: "connected" } ---------|
   |                                         |
   |-------- { type: "register",            |
   |           channelId: "ch_123",         |
   |           callsign: "fox",             |
   |           workspace: "/tmp/fox" } ---->|
   |                                         |
   |<------- { type: "registered",          |
   |           callsign: "fox",             |
   |           channelId: "ch_123" } -------|
   |                                         |
   |         [agent appears in roster]       |
   |                                         |
   |<------- { type: "message",             |
   |           id: "msg_456",               |
   |           channelId: "ch_123",         |
   |           callsign: "fox",             |
   |           content: "@fox hello",       |
   |           sender: "simen",             |
   |           systemPrompt: "You are..." } |
   |                                         |
   |-------- { type: "frame",               |
   |           channelId: "ch_123",         |
   |           frame: { i: "01ARZ...",      |
   |                    m: { type: "agent", |
   |                         sender: "fox" }|
   |                  } } ----------------->|
   |                                         |
   |-------- { type: "frame",               |
   |           channelId: "ch_123",         |
   |           frame: { i: "01ARZ...",      |
   |                    a: "Hello! " } } -->|
   |                                         |
   |-------- { type: "frame",               |
   |           channelId: "ch_123",         |
   |           frame: { i: "01ARZ...",      |
   |                    t: "2026-01...",    |
   |                    v: { type: "agent", |
   |                         sender: "fox", |
   |                         content: "Hello! How can I help?" }
   |                  } } ----------------->|
   |                                         |
   |         [message appears in channel]    |
   |                                         |
   |-------- WS close --------------------->|
   |         [agent removed from roster]     |
```

---

## Resolved Decisions

1. **Capabilities in `register`** — deferred to Stage 2, not needed yet
2. **Frame acknowledgment** — no, fire-and-forget. If frames fail, socket is dead anyway
3. **Processing errors** — yes, use `agent_error` Tymbal frame (flows through same channel broadcast)
4. **App-level heartbeat** — deferred to Stage 2, WS-level ping/pong sufficient for Stage 1

---

## Related

- [[local-agent-server-design]] — architecture context
- [[implementation-roadmap]] — Stage 1 scope
