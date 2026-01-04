# Cicada Agent System — AWS Architecture

## Overview

A durable agent execution system using **Lambda Durable Functions** for orchestration, WebSocket API for real-time client communication, and DynamoDB for persistence. Agents run autonomously, persist all state, and optionally stream to connected observers.

---

## Components

### 1. API Gateway WebSocket API

Holds persistent client connections. Clients connect with `wss://<api-id>.execute-api.<region>.amazonaws.com/<stage>?threadId=<id>`.

**Routes:**
- `$connect` → Connect Lambda
- `$disconnect` → Disconnect Lambda
- `$default` → (optional) for client-to-server messages

Connection idle timeout: set to maximum (currently 10 minutes on API Gateway, clients must ping to keep alive, or accept reconnection).

---

### 2. DynamoDB Tables

**Connections Table**
```
PK: threadId (String)
SK: connectionId (String)
Attributes:
  - connectedAt (ISO timestamp)
  - ttl (Unix timestamp for DynamoDB TTL cleanup)
```

GSI not strictly required if we only query by threadId. TTL handles orphaned connections.

**Thread Table**
```
PK: threadId (String)
SK: msgId (String, ULID)
Attributes:
  - value (Map/JSON — the message content)
  - createdAt (ISO timestamp, optional, redundant with ULID)
```

Query by threadId returns messages in ULID order (lexicographic sort).

**Thread Meta Table** (or could be SK: `_meta` in Thread Table)
```
PK: threadId (String)
Attributes:
  - status: running | waiting | complete
  - callbackId: (String, Lambda Durable Functions callback ID)
  - durableExecutionArn: (String, for inspection/cancellation)
```

---

### 3. Lambda Functions

**Connect Lambda**
- Triggered on WebSocket `$connect`
- Extracts `threadId` from query params, `connectionId` from request context
- Writes to Connections Table (even if thread doesn't exist yet)
- Queries Thread Table for all messages where PK = threadId
- Sends each as `{"i": msgId, "v": value}` via `POST @connections/{connectionId}`
- Returns 200

Note: Clients can connect before a thread is created. They simply receive no initial messages and wait for activity. This allows UI components to mount and start listening before the thread creation call completes.

**Disconnect Lambda**
- Triggered on WebSocket `$disconnect`
- Deletes from Connections Table

**Agent Durable Lambda**
- A Lambda Durable Function that runs the agent loop
- Uses `@aws/durable-execution-sdk-js` with `withDurableExecution()`
- Input: `{ threadId, ... }`
- Process:
  1. Load message history from Thread Table
  2. Query Connections Table count for threadId
  3. Generate new ULID for this message
  4. If listeners > 0: broadcast `{"i": msgId}` to declare message
  5. Call Claude with history, stream response
  6. For each chunk: if listeners > 0, broadcast `{"i": msgId, "a": chunk}`
  7. On completion: build final value object, write to Thread Table
  8. Broadcast `{"i": msgId, "v": value}` (idempotent finalization)
  9. If tool calls: execute tools via `context.step()`, persist tool results as separate messages, loop back
  10. If no tool calls (turn complete): use `context.waitForCallback()` to pause for user input

**DurableConfig:**
- `ExecutionTimeout`: 86400 (24 hours, or longer for multi-day agents)
- `RetentionPeriodInDays`: 7 (for debugging/inspection)
- Requires `AutoPublishAlias: live`

**Send Message Lambda**
- HTTP endpoint (API Gateway REST or HTTP API)
- Input: `{ threadId, content, ... }`
- Process:
  1. Generate ULID for user message
  2. Build value: `{ type: "user", content: ... }`
  3. Write to Thread Table
  4. Broadcast `{"i": msgId, "v": value}` to connected clients
  5. Read callbackId from Thread Meta Table
  6. Call `SendDurableExecutionCallbackSuccessCommand(callbackId, output)` to resume execution
  7. Return 200

**Start Thread Lambda**
- HTTP POST endpoint: `/threads/{thread_id}`
- Client provides threadId in URL path
- Checks if thread already exists (return 409 if so)
- Creates thread metadata in DynamoDB
- Invokes Agent Durable Lambda with `{ threadId }`
- Returns 201 Created

---

### 4. Agent Durable Function Flow

```
┌─────────────────────────────────────────────────────────────┐
│              Agent Durable Lambda                           │
│  withDurableExecution(async (event, context) => {          │
│                                                             │
│    while (true) {                                          │
│      ┌─────────────────┐                                   │
│      │  Load History   │ ← Thread Table query              │
│      └────────┬────────┘                                   │
│               ▼                                            │
│      ┌─────────────────┐                                   │
│      │ context.step()  │ ← Claude API call                 │
│      │  Call Claude    │   (checkpointed)                  │
│      └────────┬────────┘                                   │
│               ▼                                            │
│      ┌─────────────────┐                                   │
│      │ Persist Message │ → Thread Table write              │
│      │ Broadcast to WS │ → Connected clients               │
│      └────────┬────────┘                                   │
│               ▼                                            │
│      ┌─────────────────┐                                   │
│      │  Tool calls?    │                                   │
│      └────────┬────────┘                                   │
│               │                                            │
│    ┌──────────┴──────────┐                                 │
│    │ Yes                 │ No                              │
│    ▼                     ▼                                 │
│ ┌──────────────┐  ┌────────────────────┐                  │
│ │context.step()│  │waitForCallback()   │ ← Pauses here    │
│ │Execute Tools │  │  Store callbackId  │   (no compute)   │
│ └──────┬───────┘  │  in Thread Meta    │                  │
│        │          └─────────┬──────────┘                  │
│        │                    │                              │
│        └────────────────────┤                              │
│                             │ (resumed by SendMessage)     │
│                             ▼                              │
│                      Continue loop                         │
│    }                                                       │
│  })                                                        │
└─────────────────────────────────────────────────────────────┘
```

**Key Durable Functions concepts:**
- `context.step()` — wraps deterministic operations, checkpointed automatically
- `context.wait()` — pause for a duration (no compute charges)
- `context.waitForCallback(name, setup, options)` — pause until external callback
- Execution can pause indefinitely at `waitForCallback()`. Durable Functions support up to 1 year execution time.

---

### 5. Broadcast Mechanism

Helper function used by Agent Durable Lambda and Send Message Lambda:

```javascript
async function broadcast(threadId, message) {
  const connections = await queryConnections(threadId);
  const payload = JSON.stringify(message);

  for (const conn of connections) {
    try {
      await apigwManagement.postToConnection({
        ConnectionId: conn.connectionId,
        Data: payload,
      });
    } catch (error) {
      if (error.statusCode === 410) {
        await deleteConnection(conn);
      }
    }
  }
}
```

API Gateway Management API endpoint: `https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`

Must grant Lambda `execute-api:ManageConnections` permission.

---

## Data Flow Scenarios

### Scenario A: Agent running, no listeners

1. Agent Durable Lambda is running
2. Lambda checks Connections Table — count is 0
3. Lambda calls Claude via `context.step()`, does not stream anywhere
4. Lambda writes final message to Thread Table
5. If waiting for user input, calls `waitForCallback()` with callbackId stored in Thread Meta
6. Execution pauses (zero compute charges)

### Scenario B: Agent running, client connected

1. Same as above, but listener count > 0
2. Lambda broadcasts `{"i": msgId}` at start
3. Lambda broadcasts `{"i": msgId, "a": chunk}` for each token
4. Lambda broadcasts `{"i": msgId, "v": value}` at end
5. Client sees real-time streaming

### Scenario C: Client connects before thread exists

1. Client generates a threadId (UUID/ULID)
2. Client connects to WebSocket with that threadId
3. Connect Lambda adds connection to Connections Table
4. Thread Table query returns empty — client gets no initial messages
5. Client (or another component) calls POST /threads/{thread_id}
6. Agent starts, sees listener count > 0, streams to client

This pattern enables optimistic UI where components can mount and subscribe before coordinating the actual thread creation.

### Scenario D: Client connects mid-execution

1. Connect Lambda fires
2. Queries Thread Table — gets all completed messages
3. Sends each as `{"i": msgId, "v": value}`
4. Adds connection to Connections Table
5. Agent Durable Lambda (already running) now sees listener count > 0 on next broadcast call
6. Client receives subsequent `{"a": ...}` events for current message

Note: There's a small race window where client might miss some chunks of the in-progress message. Acceptable because the `{"v": ...}` at the end provides the complete value.

### Scenario E: User sends message to waiting agent

1. User calls Send Message endpoint
2. Lambda writes user message to Thread Table
3. Lambda broadcasts to connected clients
4. Lambda calls `SendDurableExecutionCallbackSuccessCommand` with stored callbackId
5. Durable execution resumes from `waitForCallback()`
6. Agent sees new user message in history, continues

---

## Scaling Considerations

- **WebSocket connections**: API Gateway handles scaling automatically. Connections Table partitioned by threadId.
- **Broadcast fan-out**: If many clients per thread, broadcast could be slow. Consider SQS/SNS fan-out for high fan-out scenarios.
- **Durable Functions**: Charged per step checkpoint. For high-frequency steps, costs can add up. Optimize by batching operations in single steps where possible.
- **DynamoDB**: On-demand capacity recommended. Thread Table could get hot if single thread has very high message volume.

---

## Security Considerations

- WebSocket `$connect` should validate auth (query param token, or header via Lambda authorizer)
- Send Message endpoint needs auth to prevent unauthorized thread resumption
- Store callbackIds securely — they allow resuming execution
- Consider threadId as opaque (ULID) to prevent enumeration

---

## Alternative Considerations

- **Fargate instead of Lambda for Agent**: If operations routinely exceed 15 minutes per step, or you want persistent process for connection management
- **ElastiCache/Redis for Connections**: Lower latency than DynamoDB for connection lookups, but adds operational overhead
- **IoT Core instead of API Gateway WebSocket**: Higher connection limits, but different API model
- **AppSync Subscriptions**: Managed WebSockets with GraphQL, but less control over protocol
- **Lambda Function URLs with SSE**: Simpler than WebSocket for unidirectional streaming, but no persistent connections

---

## Cost Drivers

- Lambda Durable Functions: Per-step checkpoint charges + standard Lambda compute
- API Gateway WebSocket: $0.25 per million connection-minutes, $1.00 per million messages
- Lambda: Standard compute pricing (zero during `wait()` and `waitForCallback()`)
- DynamoDB: On-demand read/write units

For an agent doing ~10 steps per conversation, ~100 messages streamed per step, costs are modest. Primary driver at scale would be WebSocket connection-minutes for long-idle connections.

---

## Comparison: Step Functions vs Lambda Durable Functions

| Aspect | Step Functions | Lambda Durable Functions |
|--------|---------------|-------------------------|
| Orchestration | External state machine | Code-native (in Lambda) |
| Wait mechanism | `waitForTaskToken` | `waitForCallback()` |
| Resume mechanism | `SendTaskSuccess` | `SendDurableExecutionCallbackSuccessCommand` |
| Max duration | 1 year | 1 year |
| Pricing | Per state transition | Per checkpoint |
| Complexity | Separate ASL definition | All in Lambda code |
| Streaming | Lambda must manage | Lambda manages (same) |

Lambda Durable Functions simplify the architecture by eliminating the separate Step Functions state machine, keeping all orchestration logic in familiar Lambda code.
