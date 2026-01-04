# Cikada

A multi-agent orchestration platform with real-time streaming, Docker sandboxing, and MCP tool integration.

## Project Structure

```
cicada/
├── packages/
│   ├── server/           # @cikada/server - HTTP API + WebSocket server
│   ├── web/              # @cikada/web - React frontend
│   ├── core/             # @cikada/core - Shared types and utilities
│   ├── storage/          # @cikada/storage - SQLite persistence
│   ├── agent/            # @cikada/agent - Agent definition framework
│   ├── local-runtime/    # @cikada/local-runtime - Docker orchestration
│   ├── fargate-runtime/  # @cikada/fargate-runtime - Docker container runtime
│   ├── aws-runtime/      # @cikada/aws-runtime - AWS Lambda deployment
│   └── mcp/              # @cikada/mcp - MCP server for artifacts
└── spec/                 # Specifications (Tymbal protocol)
```

## Key Packages

### @cikada/server

Main HTTP and WebSocket server. Handles channel management, message routing, agent spawning, and real-time streaming.

### @cikada/web

React frontend with real-time chat, Tymbal streaming, tool call visualization, and artifact board viewer.

### @cikada/fargate-runtime

Docker container runtime for Claude Code agents with isolated workspaces.

## Reference Materials

These are for understanding and inspiration, not production code:

### `prototype/`

A working implementation that proves the architecture. Reference for how things actually work: Lambda functions, DynamoDB tables, WebSocket streaming, Tymbal protocol.

### `sketches/agent-framework/`

Detailed implementation sketch exploring the framework design. Not runnable, but covers types, context implementation, driver logic, AWS SDK integration patterns, and documents design issues.

### `spec/`

Design documents. Most are informal and inspirational.

**Exception: `spec/Tymbal.md`** — The complete, authoritative Tymbal/1.0 specification. All implementations must follow it exactly.

| Spec | Status |
|------|--------|
| `Tymbal.md` | **Authoritative** - Follow exactly |
| `agent-framework.md` | Inspirational - Design intent |
| `client.md` | Inspirational - Design intent |

## Key Concepts

### Tymbal Streaming Protocol

Transport protocol for real-time message streaming. See `spec/Tymbal.md`.

```
Start:  {"i": "msgId", "t": "assistant"}
Append: {"i": "msgId", "a": "text chunk"}
Set:    {"i": "msgId", "v": "{...json...}"}
Delete: {"i": "msgId", "v": null}
```

### Lambda Durable Functions

AWS feature for long-running workflows with checkpointing:

```typescript
// Checkpointed operation - replays cached result on recovery
await context.step("fetch-data", async () => fetchData());

// Suspend at zero compute cost until callback
await context.waitForCallback("wait-for-user");

// Fan-out with per-branch checkpointing
await context.parallel("tasks", [() => taskA(), () => taskB()]);

// Batch processing with concurrency control
await context.map("items", items, (item) => process(item), { maxConcurrency: 10 });
```

### Agent Execution Modes

| Mode | Entry Point | Use Case |
|------|-------------|----------|
| Default | None | Simple agents - auto runs agentic loop |
| `onEvent` | `onEvent(event, ctx)` | React to events, stateless between |
| `onFlow` | `onFlow(ctx)` | Structured workflows, full event loop control |

## Architecture

```
User → WebSocket → API Gateway → Lambda (connect/sync/disconnect)
                                    ↓
User → HTTP POST → API Gateway → Lambda (send-message)
                                    ↓
                              Lambda Durable (agent)
                                    ↓
                              DynamoDB (state)
                                    ↓
                              WebSocket → Tymbal frames → User
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start server (from root)
pnpm dev:server

# Start web frontend (from root, in separate terminal)
pnpm dev:web

# Or start everything in parallel
pnpm dev

# Run tests
pnpm test

# Deploy an example (AWS)
cd examples/basic-assistant && sam deploy
```
