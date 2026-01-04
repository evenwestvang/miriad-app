# Unified Tymbal Streaming & Persistence Spec

## Design Goals

1. **Single persistence point** - Server always persists, agents only broadcast
2. **Consistent frame format** - Same field names across all agent types
3. **Client-generated IDs** - Preserve ordering guarantees
4. **Centralized unwrapping** - One place handles storage format conversion
5. **Positional grouping** - Use message sequence for history reconstruction (no turnId required)

---

## Proposed Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Reactive Agent │     │  SDK Sandbox    │     │  Other Agent    │
│  (stateless)    │     │  (Docker)       │     │  Types          │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │ Tymbal Frames         │ Tymbal Frames         │ Tymbal Frames
         │ (Start/Append/Set)    │ (Start/Append/Set)    │ (Start/Append/Set)
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        TymbalFrameHandler                           │
│  - Receives ALL frames from all agent types                         │
│  - Validates frame format                                           │
│  - Normalizes field names (input → args)                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
            ▼                  ▼                  ▼
     ┌────────────┐     ┌────────────┐     ┌────────────┐
     │  Storage   │     │  WebSocket │     │  @mention  │
     │            │     │  Broadcast │     │  Routing   │
     │ SetFrames  │     │            │     │            │
     │ only       │     │ ALL frames │     │ SetFrames  │
     │            │     │ (streaming)│     │ only       │
     └────────────┘     └────────────┘     └────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
     ┌──────────┐       ┌──────────┐       ┌──────────┐
     │  SQLite  │       │    UI    │       │  Other   │
     │  DynamoDB│       │ (live    │       │  Agents  │
     └──────────┘       │ updates) │       └──────────┘
                        └──────────┘
```

### Frame Routing Rules

| Frame Type | WebSocket Broadcast | Storage Persist | @mention Routing |
|------------|---------------------|-----------------|------------------|
| **StartFrame** | ✅ (typing indicator) | ❌ | ❌ |
| **AppendFrame** | ✅ (progressive text) | ❌ | ❌ |
| **SetFrame** | ✅ (finalize) | ✅ | ✅ |
| **ResetFrame** | ✅ (delete) | ✅ (delete) | ❌ |

### Streaming Flow

1. **Agent starts response** → Emits `StartFrame {i: "msgId", m: {type: "assistant", sender: "fox"}}`
2. **Handler broadcasts** → UI shows typing indicator for "fox"
3. **Agent streams text** → Emits `AppendFrame {i: "msgId", a: "Hello "}`
4. **Handler broadcasts** → UI appends "Hello " to message
5. **Agent continues** → More AppendFrames...
6. **Agent finishes** → Emits `SetFrame {i: "msgId", t: "...", v: {type: "assistant", sender: "fox", content: "Hello world"}}`
7. **Handler broadcasts + persists + routes** → UI finalizes, DB saves, @mentions trigger other agents

---

## Frame Format Specification

### Required Fields (All SetFrames)

```typescript
interface TymbalSetFrameValue {
  // Required
  type: MessageType;        // 'assistant' | 'tool_call' | 'tool_result' | ...
  sender: string;           // Agent callsign

  // Type-specific fields...
}
```

**Note:** `turnId` is **not required**. History reconstruction uses positional grouping within agent-scoped queries. Since `getAgentHistory()` filters by agent callsign, messages from a single agent are always in sequence, making explicit turn grouping unnecessary.

### Assistant Message

```typescript
// Wire format (SetFrame.v)
{
  type: 'assistant',
  sender: 'fox',
  content: 'Hello world'
}

// Storage format (StoredMessage.content)
'Hello world'  // Just the string
```

### Tool Call

```typescript
// Wire format (SetFrame.v) - NORMALIZE to 'args'
{
  type: 'tool_call',
  sender: 'fox',
  id: 'toolu_123',           // Tool use ID from LLM
  name: 'read_file',
  args: { path: '/foo.txt' } // ALWAYS 'args', never 'input'
}

// Storage format (StoredMessage.content)
{
  id: 'toolu_123',
  name: 'read_file',
  args: { path: '/foo.txt' }
}
```

### Tool Result

```typescript
// Wire format (SetFrame.v)
{
  type: 'tool_result',
  sender: 'fox',
  call_id: 'toolu_123',      // References tool_call.id
  name: 'read_file',         // Optional but helpful
  content: 'file contents',
  isError: false
}

// Storage format (StoredMessage.content)
{
  call_id: 'toolu_123',
  name: 'read_file',
  content: 'file contents',
  isError: false
}
```

---

## History Reconstruction (Positional Grouping by Sender)

When converting stored messages to LLM format, we use **positional grouping by sender**:

1. Query channel history - includes messages from all participants (users and agents)
2. Walk messages in order, tracking pending assistant messages **per sender**
3. Attach `tool_call`/`tool_result` to the most recent assistant message **from the same sender**

```typescript
function convertToAnthropicFormat(messages: StoredMessage[]): Message[] {
  const result: Message[] = [];
  // Track pending assistant message per sender
  const pendingAssistant = new Map<string, { msg: Message; index: number }>();

  for (const msg of messages) {
    switch (msg.type) {
      case 'user':
        // User messages go straight through
        result.push({ role: 'user', content: msg.content as string });
        break;

      case 'assistant':
        // Start new assistant message for this sender
        const assistantMsg: Message = {
          role: 'assistant',
          content: [{ type: 'text', text: msg.content as string }]
        };
        result.push(assistantMsg);
        pendingAssistant.set(msg.sender, { msg: assistantMsg, index: result.length - 1 });
        break;

      case 'tool_call':
        // Attach to most recent assistant message FROM SAME SENDER
        const pending = pendingAssistant.get(msg.sender);
        if (pending) {
          const tc = msg.content as { id: string; name: string; args: unknown };
          (pending.msg.content as ContentBlock[]).push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        break;

      case 'tool_result':
        // Tool result as user message (Anthropic format requirement)
        const tr = msg.content as { call_id: string; content: string };
        result.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tr.call_id, content: tr.content }]
        });
        break;
    }
  }

  return result;
}
```

This approach works because:
- **sender field** identifies which agent's turn a tool message belongs to
- Messages are stored in ULID order (timestamp-based)
- Tool calls always follow their triggering assistant message from the same sender
- Even with interleaved multi-agent messages, grouping is unambiguous

---

## ID Assignment Strategy

### Proposal: Client IDs with Server Validation

1. **Agent generates ULID** before streaming
2. **Server validates** ULID format
3. **Server uses client ID** for storage and broadcast
4. **No server reassignment** - preserves ordering

```typescript
// In TymbalFrameHandler
function handleSetFrame(frame: SetFrame) {
  // Validate client ID is valid ULID
  if (!isValidUlid(frame.i)) {
    throw new FrameError('Invalid message ID');
  }

  // Use client ID as-is
  await storage.saveMessage(spaceId, {
    id: frame.i,  // Client-generated
    ...
  });
}
```

---

## TymbalFrameHandler Implementation

### Location

New module: `packages/server/src/tymbal-handler.ts`

### Responsibilities

1. Parse incoming frame JSON
2. Validate required fields (type, sender)
3. Normalize field names (input → args)
4. Unwrap to storage format
5. Persist to storage
6. Broadcast to WebSocket
7. Route @mentions

### Interface

```typescript
interface TymbalFrameHandler {
  /**
   * Handle a Tymbal frame from any agent.
   * - ALL frames → broadcast to WebSocket clients (streaming)
   * - SetFrames → persist to storage + route @mentions
   */
  handleFrame(
    spaceId: string,
    channelId: string,
    frame: string
  ): Promise<void>;
}

function createTymbalFrameHandler(options: {
  storage: Storage;
  broadcast: (channelId: string, frame: string) => Promise<void>;
  routeMessage: (spaceId: string, channelId: string, sender: string, content: string) => Promise<void>;
}): TymbalFrameHandler;
```

### Frame Processing Logic

```typescript
async function handleFrame(spaceId: string, channelId: string, frame: string): Promise<void> {
  const parsed = JSON.parse(frame);

  // Normalize field names (input → args) if present
  if (parsed.v?.input && !parsed.v?.args) {
    parsed.v.args = parsed.v.input;
    delete parsed.v.input;
  }

  const normalizedFrame = JSON.stringify(parsed);

  // ALWAYS broadcast for streaming UX
  await broadcast(channelId, normalizedFrame);

  // Only persist and route SetFrames
  if (isSetFrame(parsed)) {
    await persistSetFrame(storage, spaceId, channelId, parsed);

    // Route @mentions for assistant messages
    if (parsed.v?.type === 'assistant' && parsed.v?.content) {
      await routeMessage(spaceId, channelId, parsed.v.sender, parsed.v.content);
    }
  }
}
```

### Persistence Logic

```typescript
async function persistSetFrame(
  storage: Storage,
  spaceId: string,
  channelId: string,
  frame: SetFrame
): Promise<void> {
  const { i: id, t: timestamp, v: value } = frame;

  // Base fields (no turnId - use positional grouping)
  const base = {
    id,
    channelId,
    sender: value.sender,
    senderType: 'agent' as const,
    timestamp,
    isComplete: true,
    addressedAgents: parseMentions(value.content ?? ''),
  };

  switch (value.type) {
    case 'assistant':
      await storage.saveMessage(spaceId, {
        ...base,
        type: 'assistant',
        content: value.content,  // string
      });
      break;

    case 'tool_call':
      await storage.saveMessage(spaceId, {
        ...base,
        type: 'tool_call',
        content: {
          id: value.id,
          name: value.name,
          args: value.args ?? value.input,  // Normalize input → args
        },
      });
      break;

    case 'tool_result':
      await storage.saveMessage(spaceId, {
        ...base,
        type: 'tool_result',
        content: {
          call_id: value.call_id,
          name: value.name,
          content: value.content,
          isError: value.isError ?? false,
        },
      });
      break;

    // ... other types
  }
}
```

---

## Agent Implementation Changes

### Reactive Agent

**Current:** Broadcasts frames, server callback persists

**Change:** No change needed - already follows proposed pattern (has sender set)

### SDK Sandbox Agent (Docker)

**Current:**
- Container POSTs frames to `/channels/:channelId/tymbal`
- `handleTymbalFrame()` reassigns IDs and persists

**Change:**
1. Container wrapper ensures `sender` is set (callsign)
2. Remove ID reassignment in server
3. Use new TymbalFrameHandler

**Container wrapper changes:**
```typescript
// In container's frame emission
function emitFrame(frame: SetFrame, context: { callsign: string }) {
  // Ensure sender is set
  frame.v.sender = context.callsign;

  // Normalize input → args
  if (frame.v.type === 'tool_call' && frame.v.input && !frame.v.args) {
    frame.v.args = frame.v.input;
    delete frame.v.input;
  }

  // POST to server
  await fetch(`${apiUrl}/channels/${channelId}/tymbal`, {
    method: 'POST',
    body: JSON.stringify(frame),
  });
}
```

### SDK Agent (AWS Lambda)

**Current:** Calls `persistMessage()` directly

**Change:**
1. Remove direct persistence calls
2. Broadcast frames to Tymbal endpoint
3. Let TymbalFrameHandler persist

---

## WebSocket Sync Changes

**Current:** Rebuilds frames differently for tool messages

**Change:** Store frames in a format that can be directly serialized

```typescript
// In handleSync
for (const msg of messages) {
  // Build frame value consistently
  const frameValue = buildFrameValue(msg);
  const frame = setFrame(msg.id, frameValue, msg.timestamp);
  ws.send(serializeFrameLine(frame));
}

function buildFrameValue(msg: StoredMessage): Record<string, unknown> {
  const base = {
    type: msg.type,
    sender: msg.sender,
    senderType: msg.senderType,
  };

  switch (msg.type) {
    case 'assistant':
    case 'user':
      return { ...base, content: msg.content };

    case 'tool_call':
    case 'tool_result':
      // Spread stored content (already in correct shape)
      return { ...base, ...(msg.content as object) };

    default:
      return { ...base, content: msg.content };
  }
}
```

---

## Success Criteria

1. All agent types emit frames with same field names (`args` not `input`)
2. All frames have `sender` set to agent callsign
3. Single persistence point (TymbalFrameHandler)
4. History reconstruction works via positional grouping by sender
5. WebSocket sync produces consistent frame format
