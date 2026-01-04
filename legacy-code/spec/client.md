# Cicada Web Client — PoC Spec

## Overview

A minimal web client for the Cicada agent system. Traditional chat interface implementing ACSP/1.0 with proper streaming, partial JSON parsing, and markdown rendering.

## Stack

- **Next.js 15** (App Router)
- **Tailwind CSS**
- **shadcn/ui** components
- **TypeScript**

## Routes

```
/                     → Redirect to /{random-uuid}
/{thread-id}          → Chat interface for that thread
```

If user navigates to `/`, generate a UUID client-side and redirect. The thread doesn't need to exist yet — the client connects and waits.

---

## UI Layout

```
┌─────────────────────────────────────────────────┐
│  Cicada                              [New Chat] │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │ User                                     │   │
│  │ What's the weather in Oslo?              │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │ Assistant                                │   │
│  │ Let me check that for you.               │   │
│  │                                          │   │
│  │ ┌─────────────────────────────────────┐ │   │
│  │ │ 🔧 search                            │ │   │
│  │ │ {"query": "weather Oslo"}            │ │   │
│  │ └─────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │ Tool Result                              │   │
│  │ {"temperature": 2, "conditions": "..."}  │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │ Assistant                          ████ │   │  ← streaming indicator
│  │ The current temperature in Oslo is 2°C  │   │
│  │ with cloudy conditions.                 │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ [Send] │
│ │ Type a message...                   │        │
│ └─────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

Keep it clean. No sidebar. Scrollable message area. Input fixed at bottom.

---

## ACSP Client Implementation

### Connection State Machine

```
DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED
                    ↓
              (on error) → RECONNECTING → CONNECTING
```

### Core State

```typescript
type MessageState = {
  id: string;                    // ULID
  buffer: string;                // Raw accumulated string
  value: object | null;          // Parsed JSON (when valid)
  status: 'streaming' | 'complete' | 'error';
};

type ThreadState = {
  messages: Map<string, MessageState>;  // Keyed by message ID
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
};
```

### Frame Processing

```typescript
function processFrame(frame: ACSPFrame, state: ThreadState): void {
  const { i: msgId, a: append, v: value } = frame;

  if (value !== undefined) {
    // Set/Reset frame
    if (value === null) {
      state.messages.delete(msgId);
    } else {
      state.messages.set(msgId, {
        id: msgId,
        buffer: value,
        value: tryParseJSON(value),
        status: 'complete',
      });
    }
    return;
  }

  if (append !== undefined) {
    // Append frame — IGNORE if message doesn't exist (late-join safety)
    const msg = state.messages.get(msgId);
    if (!msg) return;  // Critical: ignore orphaned appends

    msg.buffer += append;
    msg.value = tryParseJSON(msg.buffer);
    return;
  }

  // Start frame
  if (!state.messages.has(msgId)) {
    state.messages.set(msgId, {
      id: msgId,
      buffer: '',
      value: null,
      status: 'streaming',
    });
  }
}
```

### Partial JSON Parsing

Use a lenient JSON parser that extracts available fields from incomplete JSON.

```typescript
import { parse as parsePartialJSON } from 'best-effort-json-parser';
// or similar: partial-json, json-parser-stream

function tryParseJSON(buffer: string): object | null {
  try {
    // First try strict parse
    const result = JSON.parse(buffer);
    return typeof result === 'object' && result !== null ? result : null;
  } catch {
    // Fall back to partial parse
    try {
      const partial = parsePartialJSON(buffer);
      return typeof partial === 'object' && partial !== null ? partial : null;
    } catch {
      return null;
    }
  }
}
```

**Important:** The parser must handle:
- Truncated strings: `{"type":"assistant","content":"Hel`
- Truncated objects: `{"type":"assistant","content":`
- Incomplete arrays: `{"items":[1,2,`

---

## Message Rendering

### Render Decision Tree

```typescript
function renderMessage(msg: MessageState): ReactNode {
  const { value, status } = msg;

  // No render until we have a type
  if (!value || typeof value.type !== 'string') {
    return status === 'streaming'
      ? <MessageSkeleton />  // Pulsing placeholder
      : null;
  }

  switch (value.type) {
    case 'user':
      return <UserMessage content={value.content} />;

    case 'assistant':
      return <AssistantMessage
        content={value.content}
        streaming={status === 'streaming'}
      />;

    case 'tool_call':
      return <ToolCallMessage
        name={value.name}
        args={value.args}
        streaming={status === 'streaming'}
      />;

    case 'tool_result':
      return <ToolResultMessage
        callId={value.call_id}
        content={value.content}
      />;

    case 'error':
      return <ErrorMessage
        code={value.code}
        message={value.message}
      />;

    default:
      return <UnknownMessage type={value.type} />;
  }
}
```

### Markdown Rendering

Use `react-markdown` with GFM support for assistant messages:

```typescript
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function AssistantMessage({ content, streaming }: Props) {
  return (
    <div className="prose prose-sm dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content || ''}
      </ReactMarkdown>
      {streaming && <StreamingCursor />}
    </div>
  );
}
```

### Streaming Indicator

Simple blinking cursor or block at end of streaming content:

```typescript
function StreamingCursor() {
  return (
    <span className="inline-block w-2 h-4 bg-current animate-pulse ml-0.5" />
  );
}
```

---

## Component Hierarchy

```
app/
├── page.tsx                    # Redirect to /[uuid]
├── [threadId]/
│   └── page.tsx                # Chat page
├── components/
│   ├── chat/
│   │   ├── chat-container.tsx  # Main container, handles ACSP connection
│   │   ├── message-list.tsx    # Scrollable message area
│   │   ├── message-input.tsx   # Input + send button
│   │   └── messages/
│   │       ├── user-message.tsx
│   │       ├── assistant-message.tsx
│   │       ├── tool-call-message.tsx
│   │       ├── tool-result-message.tsx
│   │       ├── error-message.tsx
│   │       └── message-skeleton.tsx
│   └── ui/                     # shadcn components
├── lib/
│   ├── acsp/
│   │   ├── client.ts           # WebSocket connection manager
│   │   ├── parser.ts           # Frame parsing + partial JSON
│   │   └── types.ts            # TypeScript types
│   └── api.ts                  # REST API calls (create thread, send message)
└── hooks/
    └── use-thread.ts           # React hook for thread state
```

---

## Key Behaviors

### Thread Lifecycle

1. **Page load**: Extract threadId from URL
2. **Connect WebSocket**: `wss://api/threads/{threadId}/listen`
3. **Receive history**: Process `{"v": ...}` frames for existing messages
4. **Live updates**: Process streaming frames as they arrive
5. **User sends message**:
   - POST to `/threads/{threadId}/messages`
   - Message appears via WebSocket (don't optimistically add)

### Auto-reconnect

```typescript
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

function connect(threadId: string, attempt = 0) {
  const ws = new WebSocket(`wss://.../threads/${threadId}/listen`);

  ws.onclose = () => {
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    setTimeout(() => connect(threadId, attempt + 1), delay);
  };

  ws.onopen = () => {
    attempt = 0;  // Reset on successful connect
  };
}
```

### Message Ordering

Always render messages sorted by ULID:

```typescript
function sortedMessages(messages: Map<string, MessageState>): MessageState[] {
  return [...messages.values()].sort((a, b) => a.id.localeCompare(b.id));
}
```

### Scroll Behavior

- Auto-scroll to bottom when new messages arrive (if already at bottom)
- Don't auto-scroll if user has scrolled up to read history

---

## API Integration

```typescript
// Create thread (called when user sends first message)
async function createThread(threadId: string, config = {}): Promise<void> {
  await fetch(`/api/threads/${threadId}`, {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

// Send message
async function sendMessage(threadId: string, content: string): Promise<void> {
  await fetch(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}
```

---

## Styling Notes

- Dark mode support (respect system preference)
- User messages: right-aligned, primary color background
- Assistant messages: left-aligned, muted background
- Tool calls: collapsed by default, expandable to show args
- Tool results: muted, smaller text
- Errors: red/destructive styling
- Mobile responsive: full-width on small screens

---

## Dependencies

```json
{
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "tailwindcss": "^4",
    "@radix-ui/react-*": "...",
    "react-markdown": "^9",
    "remark-gfm": "^4",
    "best-effort-json-parser": "^1",
    "ulid": "^2"
  }
}
```

---

## Out of Scope (for PoC)

- Authentication
- Thread list / history
- File uploads
- Voice input
- Mobile app
- Keyboard shortcuts
- Message editing/deletion
- Syntax highlighting in code blocks (can add later with rehype-highlight)
