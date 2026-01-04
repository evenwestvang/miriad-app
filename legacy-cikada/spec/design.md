# Cicada Agent System — Design Brief

## Goal

Build a durable, long-running agent system on AWS where:

1. **Agent threads can run for hours or days**, executing steps (LLM calls, tool use) and then waiting for user input via Lambda Durable Functions callbacks.

2. **Clients can connect at any time** via WebSocket to observe a thread. They receive full history on connect, then live updates as the agent works.

3. **If no one is listening, the agent works in isolation** — it just persists results to the database. When someone connects later, they get the full state.

4. **Real-time streaming when listeners are present** — LLM output streams token-by-token to connected clients at 2-4 messages/second.

## Protocol (ACSP/1.0)

Dead simple wire format over WebSocket. Every message is one JSON object:

- `{"i": "<ulid>"}` — declare a message exists (starts streaming)
- `{"i": "<ulid>", "a": "<string>"}` — append a fragment (client accumulates, does partial JSON parsing)
- `{"i": "<ulid>", "v": <object>}` — set/replace the complete value (or `null` to delete)

Ordering comes from ULID sort order. Message types (text, tool_call, user input, forms, etc.) are just fields in the JSON value — no protocol-level event types.

## Key Components

- **API Gateway WebSocket API** — holds long-lived client connections, routes to Lambda on connect/disconnect
- **Lambda Durable Functions** — orchestrates the agent loop: run step → check if more work → wait for callback → repeat
- **Agent Durable Lambda** — loads thread history, calls Claude, streams to listeners if any, persists result, uses `waitForCallback()` to pause for user input
- **DynamoDB** — two tables: one for thread messages (keyed by threadId + msgId ULID), one for active connections (keyed by threadId + connectionId)
- **Send Message endpoint** — HTTP endpoint for user input that persists the message, broadcasts to listeners, and resumes the durable execution via `SendDurableExecutionCallbackSuccessCommand`

## Constraints

- WebSocket connections can sit idle for hours waiting for agent activity
- Agent should check listener count at step start to decide whether to stream
- Late-joining clients get history as `{"i", "v"}` events, then join live stream
- All message values are JSON objects; client uses partial JSON parsing for progressive rendering

# ACSP/1.0 Agent System — AWS Architecture

## API

```
POST /threads/{thread_id}
  Body: { /* agent configuration */ }
  → 201 Created
  → 409 Conflict (already exists)
  → Creates thread with client-specified ID and starts the agent

GET /threads/{thread_id}/listen  (WebSocket upgrade)
  → Streams ACSP/1.0 messages
  → Starts with a recap of all messages so far (using "v" messages), then streams live
  → Valid even if thread doesn't exist yet (client waits for activity)

POST /threads/{thread_id}/messages
  Body: {"content": "user message text"}
  → 202 Accepted
  → 404 Not Found (thread doesn't exist)

POST /threads/{thread_id}/cancel
  → 202 Accepted (cancellation requested)
  → 404 Not Found
  → Cancels in-progress agent execution (does not delete thread)
```

**Design principle:** Clients generate their own thread IDs. This enables:
- Components can start listening before the thread exists
- No round-trip to get an ID before wiring up UI

**Future:** The POST body will contain agent configuration — credentials, tools, system prompts, org/team ownership. This is a multi-tenant system where different threads belong to different teams.

---

## Message Format

All messages in a thread are JSON objects with a `type` field first (for partial parsing).

**User message:**
```json
{
  "type": "user",
  "content": "Hello, can you help me with something?"
}
```

**Assistant message:**
```json
{
  "type": "assistant",
  "content": "Of course! What do you need help with?"
}
```

**Tool call:**
```json
{
  "type": "tool_call",
  "id": "01JG...",
  "name": "search",
  "args": {"query": "weather in Oslo"}
}
```

**Tool result:**
```json
{
  "type": "tool_result",
  "call_id": "01JG...",
  "content": {"temperature": 2, "conditions": "cloudy"}
}
```

**Error (server-side):**
```json
{
  "type": "error",
  "code": "execution_failed",
  "message": "Agent execution failed: rate limit exceeded"
}
```

Note: Message content format is application-specific, not part of ACSP. The protocol only cares that values are JSON objects.

---

## Agent Execution Model

The agent runs as a **Lambda Durable Function** using `@aws/durable-execution-sdk-js`:

```javascript
import { withDurableExecution } from "@aws/durable-execution-sdk-js";

export const handler = withDurableExecution(async (event, context) => {
  const { threadId } = event;

  while (true) {
    // Load history from DynamoDB
    const history = await context.step(async () => {
      return await loadThreadHistory(threadId);
    });

    // Call Claude (checkpointed)
    const response = await context.step(async () => {
      return await callClaude(history, {
        onChunk: (chunk) => broadcastIfListeners(threadId, chunk)
      });
    });

    // Persist assistant message
    await context.step(async () => {
      await persistMessage(threadId, response);
      await broadcastComplete(threadId, response);
    });

    // Handle tool calls if any
    if (response.toolCalls?.length > 0) {
      for (const toolCall of response.toolCalls) {
        const result = await context.step(async () => {
          return await executeTool(toolCall);
        });
        await context.step(async () => {
          await persistToolResult(threadId, toolCall.id, result);
        });
      }
      continue; // Loop back for next Claude turn
    }

    // No tool calls — wait for user input
    const userMessage = await context.waitForCallback(
      `user-input-${Date.now()}`,
      async (callbackId) => {
        await storeCallbackId(threadId, callbackId);
      },
      { timeout: { hours: 24 } }
    );

    // User message already persisted by Send Message Lambda
    // Loop continues to process user input
  }
});
```

---

## Key Differences from Step Functions

| Step Functions | Lambda Durable Functions |
|----------------|-------------------------|
| Separate state machine definition (ASL) | All logic in Lambda code |
| `waitForTaskToken` integration | `context.waitForCallback()` |
| `SendTaskSuccess` to resume | `SendDurableExecutionCallbackSuccessCommand` |
| State transitions visible in console | Execution steps visible in Lambda console |
| Pricing per state transition | Pricing per checkpoint |

Lambda Durable Functions provide a simpler, code-first approach while maintaining the same durability guarantees.
