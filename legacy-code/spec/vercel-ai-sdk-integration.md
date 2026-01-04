# Vercel AI SDK 6 Integration with CICADA

**Status:** Design Reference
**Date:** 2024-12-24
**Updated:** Added context-free agents and protocol bridge

## Executive Summary

This document analyzes the feasibility of running agents written with Vercel's AI SDK 6 under CICADA's durable execution runtime. The integration is **feasible** and requires:

1. A new **context-free agent mode** in CICADA (caller-managed context, durable execution)
2. An **adapter layer** that bridges AI SDK 6's `Agent` interface to CICADA
3. A **protocol bridge** between AI SDK's Data Stream Protocol and Tymbal

---

## Part 1: Context-Free Agents

### The Problem

CICADA's current agent model assumes server-managed conversation history stored in DynamoDB. AI SDK 6 agents expect caller-managed context—the client provides the full messages array on each request.

These are fundamentally different state management models:

| Aspect | CICADA Durable Agent | AI SDK Agent |
|--------|---------------------|--------------|
| History | Server-managed (DynamoDB) | Caller-provided |
| Thread state | Persistent | Ephemeral |
| Multi-turn | Server tracks conversation | Client tracks conversation |
| Typical use | Research assistant, collaborator | Customer support, API agents |

### The Solution: Context-Free Agent Mode

Introduce a new agent mode that separates **state management** from **execution durability**:

```
┌─────────────────────────────────────────────────────────────┐
│                      CICADA Runtime                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Durable Agent              Context-Free Agent              │
│   ─────────────              ─────────────────              │
│   Thread history: DynamoDB   Thread history: None            │
│   Context: Server-managed    Context: Per-request            │
│   Execution: Durable ✓       Execution: Durable ✓           │
│   Tool checkpoints: Yes      Tool checkpoints: Yes           │
│   waitForCallback: Yes       waitForCallback: Yes            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Even "stateless" agents benefit from durable execution because:

1. **Lambda timeout protection** — 15 min max, but tool loops can run longer
2. **Cost efficiency** — checkpoint between LLM calls, don't pay for idle time
3. **Reliability** — if tool call 4 of 5 fails, resume from 4, not 1

### API Design

```typescript
import { defineAgent } from "@cikada/agent";

// Context-free agent - caller provides messages
export const supportAgent = defineAgent({
  mode: "context-free",  // NEW: vs "durable" (default)
  system: "You are a helpful support agent.",

  tools: {
    lookup_order: {
      description: "Look up order status",
      parameters: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => getOrderStatus(orderId),
    },
  },

  // Optional: control loop termination (maps to AI SDK's stopWhen)
  stopWhen: (step, count) => count >= 20,
});
```

### Runtime Behavior

**Durable mode (default):**
1. Load thread history from DynamoDB
2. Append user message to history
3. Run agent loop with tools
4. Persist all messages
5. Stay open for next message

**Context-free mode:**
1. Receive messages array from request
2. Run agent loop with tools (checkpointed via `ctx.step()`)
3. Stream response via Tymbal
4. Forget everything (no persistence)

### Wire Protocol Changes

For context-free agents, the request includes the full messages array:

```typescript
// WebSocket message to context-free agent
{
  "type": "generate",
  "messages": [
    { "role": "user", "content": "What's my order status?" },
    { "role": "assistant", "content": "I'd be happy to help. What's your order ID?" },
    { "role": "user", "content": "Order #12345" }
  ]
}
```

Response streams via standard Tymbal frames.

---

## Part 2: AI SDK Protocol Bridge

### Protocol Comparison

| Aspect | AI SDK Data Stream | Tymbal |
|--------|-------------------|------|
| Format | SSE with JSON objects | NDJSON |
| Message ID | `messageId` field | ULID in `i` field |
| Text streaming | `text-delta` type | Append frame `{"a": "..."}` |
| Completion | `finish` type | Set frame `{"v": {...}}` |
| Tool calls | `tool-input-*` types | Metadata in message object |
| Error handling | `error` type | Error frame `{"error": "..."}` |
| Reconnection | None built-in | Sync with `since` cursor |

### Bridge Implementation

The bridge translates AI SDK's Data Stream Protocol to Tymbal:

```typescript
// ai-sdk-to-gasp-bridge.ts

import { ulid } from "ulid";

type AISDKFrame =
  | { type: "start"; messageId: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "finish" }
  | { type: "error"; errorText: string };

type TymbalFrame =
  | { i: string; m?: Record<string, unknown> }  // Start
  | { i: string; a: string }                      // Append
  | { i: string; t: string; v: Record<string, unknown> }  // Set
  | { error: string; message?: string };          // Error

export function createProtocolBridge() {
  const messageIdMap = new Map<string, string>(); // AI SDK ID → ULID
  const messageBuffers = new Map<string, string>(); // ULID → accumulated text

  function getOrCreateUlid(aiSdkId: string): string {
    if (!messageIdMap.has(aiSdkId)) {
      messageIdMap.set(aiSdkId, ulid());
    }
    return messageIdMap.get(aiSdkId)!;
  }

  function* translateFrame(frame: AISDKFrame): Generator<TymbalFrame> {
    switch (frame.type) {
      case "start": {
        const id = getOrCreateUlid(frame.messageId);
        messageBuffers.set(id, "");
        yield { i: id, m: { type: "assistant" } };
        break;
      }

      case "text-delta": {
        const id = getOrCreateUlid(frame.id);
        const buffer = messageBuffers.get(id) ?? "";
        messageBuffers.set(id, buffer + frame.delta);
        yield { i: id, a: frame.delta };
        break;
      }

      case "text-end": {
        // No Tymbal equivalent needed - we emit set frame on finish
        break;
      }

      case "tool-input-start": {
        // Create a new message for tool call visualization
        const toolMsgId = ulid();
        yield {
          i: toolMsgId,
          m: {
            type: "tool_call",
            toolName: frame.toolName,
            toolCallId: frame.toolCallId,
            status: "pending"
          }
        };
        break;
      }

      case "tool-input-available": {
        const toolMsgId = ulid();
        yield {
          i: toolMsgId,
          t: new Date().toISOString(),
          v: {
            type: "tool_call",
            toolName: frame.toolName,
            toolCallId: frame.toolCallId,
            input: frame.input,
            status: "executing"
          }
        };
        break;
      }

      case "tool-output-available": {
        const toolMsgId = ulid();
        yield {
          i: toolMsgId,
          t: new Date().toISOString(),
          v: {
            type: "tool_result",
            toolCallId: frame.toolCallId,
            output: frame.output,
            status: "complete"
          }
        };
        break;
      }

      case "finish": {
        // Emit set frames for all active messages
        for (const [aiSdkId, gaspId] of messageIdMap) {
          const content = messageBuffers.get(gaspId) ?? "";
          yield {
            i: gaspId,
            t: new Date().toISOString(),
            v: { type: "assistant", content }
          };
        }
        break;
      }

      case "error": {
        yield { error: "agent_error", message: frame.errorText };
        break;
      }
    }
  }

  return { translateFrame };
}
```

### Streaming Flow

```
AI SDK Agent                    Protocol Bridge                 Tymbal Client
     │                               │                               │
     │──{"type":"start",...}────────▶│                               │
     │                               │──{"i":"01J...","m":{...}}────▶│
     │──{"type":"text-delta",...}───▶│                               │
     │                               │──{"i":"01J...","a":"Hello"}──▶│
     │──{"type":"text-delta",...}───▶│                               │
     │                               │──{"i":"01J...","a":" world"}─▶│
     │──{"type":"finish"}───────────▶│                               │
     │                               │──{"i":"01J...","t":...,"v":..}▶│
     │                               │                               │
```

### Reverse Bridge (Tymbal to AI SDK)

For tools that need to receive AI SDK protocol:

```typescript
export function gaspToAiSdk(frame: TymbalFrame): AISDKFrame | null {
  if ("error" in frame) {
    return { type: "error", errorText: frame.message ?? frame.error };
  }

  if ("a" in frame) {
    return { type: "text-delta", id: frame.i, delta: frame.a };
  }

  if ("v" in frame && frame.v !== null) {
    // This is a completion frame
    return { type: "finish" };
  }

  if ("m" in frame) {
    return { type: "start", messageId: frame.i };
  }

  return null;
}
```

---

## Part 3: The Adapter

### Complete Adapter Implementation

```typescript
// @cikada/ai-sdk-adapter

import { ToolLoopAgent, tool } from "ai";
import { defineAgent, Context, ToolDefinition } from "@cikada/agent";
import { createProtocolBridge } from "./protocol-bridge";

export interface FromAISDKOptions {
  /**
   * How to handle tool execution durability.
   * - "wrap": Wrap each tool in ctx.step() for checkpointing (default)
   * - "passthrough": Let AI SDK handle tools directly (no durability)
   */
  toolDurability?: "wrap" | "passthrough";
}

export function fromAISDKAgent(
  agent: ToolLoopAgent,
  options: FromAISDKOptions = {}
) {
  const { toolDurability = "wrap" } = options;

  // Extract tools from AI SDK agent and convert to CICADA format
  const cicadaTools: Record<string, ToolDefinition> = {};

  for (const [name, aiTool] of Object.entries(agent.tools)) {
    cicadaTools[name] = {
      description: aiTool.description,
      parameters: aiTool.inputSchema,
      execute: async (args, ctx) => {
        // Handle approval if the AI SDK tool requires it
        if (aiTool.needsApproval) {
          const approved = await requestApproval(name, args, ctx);
          if (!approved) {
            return { error: "Tool execution denied by user" };
          }
        }

        // Execute with or without durability wrapping
        if (toolDurability === "wrap") {
          return ctx.step(`tool:${name}:${Date.now()}`, () =>
            aiTool.execute(args)
          );
        }
        return aiTool.execute(args);
      },
    };
  }

  return defineAgent({
    mode: "context-free",
    name: agent.id ?? "ai-sdk-agent",
    system: agent.instructions ?? "",
    tools: cicadaTools,

    // Map AI SDK's stopWhen to CICADA
    stopWhen: agent.stopWhen,

    // Custom event handler to use AI SDK's execution model
    onEvent: async (event, ctx) => {
      if (event.type !== "message") return;

      const bridge = createProtocolBridge();

      // Use AI SDK's streaming
      const stream = await ctx.step("llm:stream", () =>
        agent.stream({
          messages: ctx.history,  // Context-free: history comes from request
        })
      );

      // Bridge the stream to Tymbal
      const messageHandle = ctx.message({ type: "assistant" });

      for await (const chunk of stream.textStream) {
        await messageHandle.stream(chunk);
      }

      // Finalize
      await messageHandle.set({
        type: "assistant",
        content: stream.text,
        usage: stream.usage,
      });
    },
  });
}

async function requestApproval(
  toolName: string,
  args: unknown,
  ctx: Context
): Promise<boolean> {
  // Send approval request to client
  const requestMsg = ctx.message({
    type: "tool_approval_request",
    tool: toolName,
    args,
  });

  // Wait for user response at zero compute cost
  const response = await ctx.waitForCallback(`approval:${toolName}:${Date.now()}`);

  // Clean up the request message
  await requestMsg.delete();

  return response?.approved === true;
}
```

### Usage

```typescript
// Before: Direct AI SDK usage
import { ToolLoopAgent, tool } from "ai";

const supportAgent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4.5",
  instructions: "You are a helpful customer support agent.",
  tools: {
    lookupOrder: tool({
      description: "Look up order status",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => getOrderStatus(orderId),
    }),
  },
  stopWhen: stepCountIs(10),
});

// After: Running under CICADA with durability
import { fromAISDKAgent } from "@cikada/ai-sdk-adapter";
import { registerProcesses } from "@cikada/aws-runtime";

const durableSupportAgent = fromAISDKAgent(supportAgent);

registerProcesses({
  support: durableSupportAgent,
});
```

---

## Part 4: Mapping Table (Updated)

| AI SDK 6 | CICADA | Notes |
|----------|--------|-------|
| `ToolLoopAgent` | `defineAgent({ mode: "context-free" })` | Context-free agent mode |
| `agent.generate({ messages })` | Request with messages array | Caller-provided context |
| `tool({ execute })` | `tools[name].execute` | Wrapped in `ctx.step()` |
| `needsApproval` | `ctx.waitForCallback()` | Human-in-the-loop |
| `stream()` | Tymbal frames via bridge | Protocol translation |
| `stopWhen` | `stopWhen` config | Direct mapping |
| `Output.object()` | Return structured data | Via message metadata |
| Data Stream Protocol | Tymbal | Bridge translates |

---

## Part 5: Implementation Phases

### Phase 1: Context-Free Agent Mode
- Add `mode: "context-free"` to `defineAgent`
- Update runtime to accept messages array in request
- Skip DynamoDB history load/persist for context-free mode
- Keep `ctx.step()` durability for tool execution

### Phase 2: Protocol Bridge
- Implement AI SDK → Tymbal translation
- Handle all AI SDK frame types
- Support tool call visualization in Tymbal

### Phase 3: Adapter Package
- Create `@cikada/ai-sdk-adapter` package
- Implement `fromAISDKAgent()` function
- Tool wrapping with durability
- Approval flow integration

### Phase 4: Testing & Documentation
- Integration tests with real AI SDK agents
- Performance benchmarks
- Migration guide for AI SDK users

---

## Open Questions

### 1. Provider Support

CICADA currently uses Anthropic. The adapter allows AI SDK's provider abstraction. Should we:
- A) Force Anthropic for all agents (simpler)
- B) Allow any provider via AI SDK (more flexible)
- C) Add provider abstraction to CICADA core

**Recommendation:** Option B via the adapter, keeping CICADA core simple.

### 2. Step Granularity

For context-free agents, what should checkpoint?
- Each tool execution: Yes
- Each LLM call: Yes
- Token streaming: No (too much overhead)

### 3. `stopWhen` Implementation

Should `stopWhen` be:
- A) A new CICADA primitive available to all agents
- B) Only available via the AI SDK adapter

**Recommendation:** Add to CICADA core as it's generally useful.

---

## Conclusion

Running Vercel AI SDK 6 agents under CICADA requires:

1. **Context-free agent mode** — Separates state management from execution durability
2. **Protocol bridge** — Translates AI SDK Data Stream ↔ Tymbal
3. **Adapter function** — `fromAISDKAgent()` for seamless conversion

This enables teams to:
- Write agents using familiar AI SDK 6 API
- Deploy on CICADA's durable AWS infrastructure
- Benefit from checkpoint/resume for long tool chains
- Use zero-cost waiting for human-in-the-loop approval
- Stream responses via Tymbal to any CICADA client
