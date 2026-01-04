# Cicada Agent Framework

## The Simplest Agent

```typescript
import { defineAgent } from "@cikada/agent";

export default defineAgent({
  system: "You are a helpful assistant.",
});
```

That's it. No handler needed. The default behavior:
- On each message, run the agentic loop (LLM + tools until done)
- Handle history, cache markers, streaming, persistence

For custom behavior, define `onEvent` or `onFlow` (not both).

---

## With Tools

```typescript
import { defineAgent } from "@cikada/agent";
import { z } from "zod";

export default defineAgent({
  system: "You help users check the weather.",

  tools: {
    get_weather: {
      description: "Get current weather for a location",
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => {
        const res = await fetch(`https://weather.api/${location}`);
        return res.json();
      },
    },
  },
});
```

Still no handler needed. The default behavior runs `ctx.llm.generate()` which:
1. Calls Claude with history + tools
2. If tool calls → executes all in parallel, loops back to Claude
3. When done → streams response

---

## Taking Control: onFlow

For structured workflows with stages, gates, or when you need the full event loop:

```typescript
export default defineAgent({
  name: "onboarding",
  system: "You guide users through onboarding.",

  async onFlow(ctx) {
    // Stage 1: Greeting
    const first = await ctx.events.next();
    await ctx.llm.generate("Welcome! Let's get you set up. What's your name?");

    // Stage 2: Collect name
    const nameEvent = await ctx.events.next();
    const name = nameEvent.content;

    // Stage 3: Confirm and complete
    await ctx.llm.generate(`Great to meet you, ${name}! You're all set.`);
  },
});
```

`onFlow` gives you:
- Full control of the event loop
- Durable execution throughout the flow
- Access to `ctx.events.next()` (not available in `onEvent`)

### Custom tool handling

```typescript
async onEvent(event, ctx) {
  if (event.type === "message") {
    let response = await ctx.llm.generateStep(event.content);

    while (response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        if (call.name === "dangerous_tool") {
          await ctx.toolResult(call.id, { error: "Not allowed" });
        } else {
          await ctx.executeTool(call);
        }
      }
      response = await ctx.llm.generateStep();
    }
  }
}
```

### Custom history/cache control

```typescript
async onEvent(event, ctx) {
  if (event.type === "message") {
    const messages = [
      { role: "system", content: mySystemPrompt, cache_control: { type: "ephemeral" } },
      ...ctx.history.slice(-10),
      { role: "user", content: event.content },
    ];

    await ctx.llm.generateStep({ messages });
  }
}
```

### Custom message handling

```typescript
async onEvent(event, ctx) {
  if (event.type === "message") {
    const status = ctx.message({ type: "status", state: "thinking" });
    const response = await ctx.llm.generateStep(event.content);
    await status.set({ type: "status", state: "done" });
  }
}
```

```typescript
async onEvent(event, ctx) {
  if (event.type === "message") {
    const msg = ctx.message({
      type: "assistant",
      displayName: "Research Assistant",
      icon: "🔬"
    });

    await msg.stream("Let me ");
    await msg.stream("think about that...");

    const result = await ctx.step("slow-op", () => someSlowOperation());

    await msg.stream(`\n\nThe answer is ${result}`);
  }
}
```

---

## Parallel Execution

For fan-out work, use `ctx.parallel()` and `ctx.map()`. These map directly to Lambda Durable primitives - each branch checkpoints independently, and the caller suspends at zero compute cost until all complete.

### parallel() - fixed set of different tasks

```typescript
async onFlow(ctx) {
  // Run three different operations concurrently
  const [users, orders, metrics] = await ctx.parallel("fetch-data", [
    async () => ctx.step("users", () => fetchUsers()),
    async () => ctx.step("orders", () => fetchOrders()),
    async () => ctx.step("metrics", () => fetchMetrics()),
  ]);

  await ctx.llm.generate(`Found ${users.length} users, ${orders.length} orders.`);
}
```

### map() - process array with concurrency control

```typescript
async onFlow(ctx) {
  const items = await ctx.step("get-items", () => getItemsToProcess());

  // Process with concurrency limit - each item checkpoints independently
  const results = await ctx.map(
    "process-items",
    items,
    async (item, index) => {
      return ctx.step(`item-${index}`, () => processItem(item));
    },
    { maxConcurrency: 10 }
  );

  await ctx.llm.generate(`Processed ${results.length} items.`);
}
```

### Note on tool execution

`ctx.llm.generate()` already executes tool calls in parallel by default. Use `generateStep` with manual `ctx.parallel()` only when you need custom control (filtering, logging, etc).

### Parallel sub-agent spawning

```typescript
async onFlow(ctx) {
  const topics = ["market trends", "competitors", "regulations"];

  // Spawn researchers in parallel
  const handles = await ctx.map(
    "spawn-researchers",
    topics,
    async (topic) => ctx.spawn("researcher", { topic }),
    { maxConcurrency: 3 }
  );

  // Collect results as they arrive
  const results = [];
  while (results.length < handles.length) {
    const event = await ctx.events.next();

    if (event.type === "agent:complete") {
      results.push(event.result);
    } else if (event.type === "agent:error") {
      results.push({ error: event.error.message });
    }
    // Ignore user messages while waiting, or handle them
  }

  await ctx.llm.generate(`Research complete: ${JSON.stringify(results)}`);
}
```

---

## Execution Model

### onEvent (simple)

```
Event arrives
       ↓
Runtime calls agent.onEvent(event, ctx)
       ↓
Agent handles event
       ↓
Agent returns (can die, will be called again for next event)
```

### onFlow (structured)

```
Flow created
       ↓
Runtime calls agent.onFlow(ctx)
       ↓
Agent calls ctx.events.next() (blocks until event)
       ↓
Agent handles event, calls next() again
       ↓
Flow continues until agent returns
```

On AWS: blocking on `ctx.events.next()` = Lambda Durable `waitForCallback()` (zero compute cost)
Locally: blocking = HTTP server waiting for next request

---

## AgentContext Interface

```typescript
interface AgentContext {
  // Event stream
  events: AsyncIterable<FlowEvent>;

  // LLM operations
  llm: {
    generate(content: string): Promise<GenerateResult>;        // Full agentic loop
    generateStep(content?: string, opts?: StepOptions): Promise<StepResult>;  // Single LLM call
  };

  // Tool control (when using generateStep manually)
  executeTool(call: ToolCall): Promise<ToolResult>;
  toolResult(callId: string, result: any): Promise<void>;

  // Message control (Tymbal abstraction)
  message(value: object): MessageHandle;
  history: Message[];

  // Sub-agents
  spawn(agentName: string, input: any): Promise<AgentHandle>;

  // Durable execution
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  // Parallel execution (maps to Lambda Durable primitives)
  parallel<T extends unknown[]>(name: string, fns: Array<() => Promise<T[number]>>): Promise<T>;
  map<T, R>(name: string, items: T[], fn: (item: T, index: number) => Promise<R>, opts?: { maxConcurrency?: number }): Promise<R[]>;

  // Config
  config: AgentConfig;
  threadId: string;
  input?: any;  // Input from spawn() - set for sub-agents
}

interface MessageHandle {
  id: string;
  stream(text: string): Promise<void>;  // Append text to content
  set(value: object): Promise<void>;    // Replace entire value
  delete(): Promise<void>;
}

interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
}

interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

interface AgentHandle {
  id: string;
  parentId?: string;  // Set if this is a sub-agent
  input: any;
}
```

---

## Runtime Responsibilities

| Concern | Runtime handles | Agent can override |
|---------|-----------------|-------------------|
| Event delivery | ✓ Yields events to `ctx.events` | — |
| History loading | ✓ Auto-loads into `ctx.history` | Modify or replace |
| Cache markers | ✓ Auto-inserted on system + old messages | Build custom messages |
| Streaming | ✓ Transparent via `generate/generateStep` | Use `ctx.message()` |
| Tool execution | ✓ Auto-loop in `generate` (parallel) | Use `generateStep` for manual control |
| Message persistence | ✓ Auto-persists all messages | — |
| Step checkpointing | ✓ Wraps `generateStep`, tool calls | Use `ctx.step()` for custom |
| Parallel fan-out | ✓ Maps to Lambda Durable | `ctx.parallel()`, `ctx.map()` |
| Sub-agent lifecycle | ✓ Routes events between parent/child | — |

---

## Sub-Agents

Agents can spawn sub-agents. Events arrive naturally:
- `message` — human sent a message
- `agent:complete` — sub-agent finished
- `agent:error` — sub-agent failed

Sub-agents are autonomous - they receive input at spawn time and run to completion.

### Simple: onEvent coordinator

```typescript
export default defineAgent({
  name: "coordinator",
  system: "You coordinate research tasks.",

  tools: {
    research: {
      description: "Spawn a researcher",
      parameters: z.object({ topic: z.string() }),
      execute: async ({ topic }, ctx) => {
        await ctx.spawn("researcher", { topic });
        return { status: "spawned" };
      },
    },
  },

  async onEvent(event, ctx) {
    if (event.type === "message") {
      await ctx.llm.generate(event.content);
    }
    else if (event.type === "agent:complete") {
      await ctx.llm.generate(`Research complete: ${event.result}`);
    }
    else if (event.type === "agent:error") {
      await ctx.llm.generate(`Research failed: ${event.error.message}`);
    }
  },
});
```

### Structured: onFlow with multiple agents

```typescript
export default defineAgent({
  name: "research-flow",
  system: "You run structured research.",

  async onFlow(ctx) {
    // Stage 1: Get the request
    const first = await ctx.events.next();
    await ctx.llm.generate("Starting parallel research...");

    // Stage 2: Spawn workers
    await ctx.spawn("researcher", { topic: "market trends" });
    await ctx.spawn("researcher", { topic: "competitors" });

    // Stage 3: Collect results
    const results = [];
    while (results.length < 2) {
      const event = await ctx.events.next();

      if (event.type === "agent:complete") {
        results.push(event.result);
      }
      else if (event.type === "message") {
        await ctx.llm.generate("Still working on it...");
      }
    }

    // Stage 4: Synthesize
    await ctx.llm.generate(`Done! ${synthesize(results)}`);
  },
});
```

### The researcher sub-agent

```typescript
export default defineAgent({
  name: "researcher",
  system: "You research topics thoroughly and return findings.",

  tools: {
    web_search: {
      description: "Search the web",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => searchWeb(query),
    },
  },

  async onFlow(ctx) {
    const { topic } = ctx.input;  // Input from spawn()

    // Do the research autonomously
    const result = await ctx.llm.generate(`Research the topic: ${topic}`);

    return { topic, findings: result.text };  // Parent receives agent:complete
  },
});
```

### Event types

```typescript
type FlowEvent =
  | { type: "message"; content: string }
  | { type: "agent:complete"; agent: AgentHandle; result: any }
  | { type: "agent:error"; agent: AgentHandle; error: Error };
```

---

## Sub-Agent Threading Model

Sub-agents get their own threads, linked to parent via `parentId`. All agents are created equal - some just happen to have a parent.

- Sub-agent messages stream to their own thread, not the parent's
- Parent receives `agent:complete`, `agent:question`, `agent:error` events
- If parent wants results visible in their thread, they relay via their own messages
- Sub-agents can spawn their own sub-agents (nested hierarchies allowed)

If parent dies while sub-agents run, sub-agents continue. Parent resumes from checkpoint and receives pending events.

## Open Questions

1. Sub-agent cancellation: how does parent abort a running sub-agent?
2. Resource limits: max sub-agents per parent? Max nesting depth?
3. Explicit state management: typed `state` with schema for long-running agents?
4. Intra-agent communication: should sub-agents be able to ask parent for guidance? (deferred)
