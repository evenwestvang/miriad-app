# Agent Server Implementation Notes

Practical guidance for implementing the Cast backend, focused on avoiding the local/production divergence problem.

---

## The Core Problem

In the original codebase, the gap between "local Node server" and "AWS Lambda + API Gateway" grew until porting features to AWS took longer than building them. This is a common trap:

1. Start with Express locally (fast iteration)
2. Add Lambda handlers for AWS (slight duplication)
3. Features accumulate, handlers diverge
4. Bug fixes need two implementations
5. Eventually, nobody trusts that local behavior matches prod

**Goal:** One implementation of business logic, deployed anywhere.

---

## Recommended Architecture: Thin Adapter Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     Business Logic                          │
│   (Handlers, Services, Storage Interface)                   │
│                                                             │
│   handleCreateChannel(input) → Channel                      │
│   handleSendMessage(input) → Message                        │
│   handleSpawnAgent(input) → AgentInstance                   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  Hono    │   │  Lambda  │   │  Test    │
        │ Adapter  │   │ Adapter  │   │ Harness  │
        └──────────┘   └──────────┘   └──────────┘
              │               │               │
              ▼               ▼               ▼
          Local Dev       AWS Prod        Unit Tests
```

### Why This Works

1. **Business logic is framework-agnostic** — pure functions that take input and return output
2. **Adapters are trivial** — just wire HTTP/Lambda events to handlers
3. **Same logic runs everywhere** — local, Lambda, tests, CLI
4. **Easy to test** — call handlers directly, no HTTP overhead

### Example Structure

```typescript
// handlers/channels.ts — Pure business logic
export async function createChannel(
  ctx: AppContext,
  input: CreateChannelInput
): Promise<Channel> {
  // Validate
  if (!input.name) throw new ValidationError('name required');

  // Resolve focus area
  const focus = input.focusSlug
    ? await ctx.storage.getArtifact(ctx.spaceId, 'root', input.focusSlug)
    : null;

  // Create channel
  const channel = await ctx.storage.createChannel(ctx.spaceId, {
    name: input.name,
    tagline: input.tagline ?? focus?.props?.defaultTagline,
    // ...
  });

  // Spawn focus agents
  for (const agentSlug of focus?.props?.agents ?? []) {
    await spawnAgent(ctx, channel.id, agentSlug);
  }

  return channel;
}

// adapters/hono.ts — Local dev server
import { Hono } from 'hono';
import { createChannel } from '../handlers/channels';

const app = new Hono();

app.post('/channels', async (c) => {
  const ctx = buildContext(c);  // Extract spaceId, userId from session
  const input = await c.req.json();
  const channel = await createChannel(ctx, input);
  return c.json({ channel }, 201);
});

// adapters/lambda.ts — AWS deployment
import { createChannel } from '../handlers/channels';

export const createChannelHandler = async (event: APIGatewayEvent) => {
  const ctx = buildContextFromEvent(event);
  const input = JSON.parse(event.body ?? '{}');
  const channel = await createChannel(ctx, input);
  return {
    statusCode: 201,
    body: JSON.stringify({ channel }),
  };
};
```

---

## Framework Choice: Hono

Recommend **Hono** over Express for several reasons:

1. **Multi-runtime** — Same code runs on Node, Bun, Deno, Cloudflare Workers, Lambda
2. **TypeScript-first** — Better DX, type-safe routing
3. **Lightweight** — Faster cold starts in Lambda
4. **Modern API** — Web standard Request/Response, async-native

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

// Works locally
serve({ fetch: app.fetch, port: 3001 });

// Works in Lambda (with adapter)
export const handler = handle(app);
```

Hono has official AWS Lambda adapter: `@hono/aws-lambda`

---

## Storage Abstraction

The spec defines data semantics, not storage backend. Implementation uses PlanetScale.

```typescript
// storage/interface.ts
export interface Storage {
  // Channels
  createChannel(spaceId: string, input: CreateChannelInput): Promise<Channel>;
  getChannel(spaceId: string, channelId: string): Promise<Channel | null>;
  listChannels(spaceId: string): Promise<Channel[]>;

  // Messages
  saveMessage(spaceId: string, message: StoredMessage): Promise<void>;
  getMessages(spaceId: string, channelId: string, opts: QueryOpts): Promise<StoredMessage[]>;

  // Artifacts
  createArtifact(spaceId: string, channelId: string, artifact: Artifact): Promise<Artifact>;
  // ...
}

// storage/planetscale.ts
export class PlanetScaleStorage implements Storage {
  constructor(private db: Connection) {}

  async createChannel(spaceId: string, input: CreateChannelInput): Promise<Channel> {
    const id = ulid();
    await this.db.execute(
      'INSERT INTO channels (id, space_id, name, ...) VALUES (?, ?, ?, ...)',
      [id, spaceId, input.name, ...]
    );
    return { id, spaceId, ...input };
  }
}
```

**Key principle:** Handlers depend on `Storage` interface, not implementation. Swap backends without touching business logic.

---

## Container Orchestration

For containerized agents (claude-code/sandbox), abstract the orchestrator:

```typescript
// runtime/interface.ts
export interface ContainerOrchestrator {
  spawn(config: ContainerConfig): Promise<ContainerInstance>;
  stop(containerId: string): Promise<void>;
  exec(containerId: string, command: string[]): Promise<ExecResult>;
  logs(containerId: string): AsyncIterable<string>;
}

// runtime/docker.ts — Local dev
export class DockerOrchestrator implements ContainerOrchestrator {
  async spawn(config: ContainerConfig): Promise<ContainerInstance> {
    // Use dockerode
  }
}

// runtime/fargate.ts — AWS prod (if needed)
export class FargateOrchestrator implements ContainerOrchestrator {
  async spawn(config: ContainerConfig): Promise<ContainerInstance> {
    // Use AWS SDK
  }
}
```

For local dev, Docker is the orchestrator. If AWS prod needs Fargate, same interface, different implementation.

---

## WebSocket Strategy

WebSocket is inherently stateful — harder to abstract across Lambda (which is stateless).

### Options:

1. **Lambda + API Gateway WebSocket** — AWS-native, but different code path
2. **Long-running container** — Same WebSocket server local and prod
3. **Hybrid** — HTTP for most things, WebSocket only where essential

### Recommendation: Start with container-based WebSocket

Run the Hono server in a container (ECS/Fargate) for WebSocket support. This keeps local and prod identical for the real-time streaming path.

If Lambda is needed for cost reasons later, API Gateway WebSocket can be added as a separate concern (connection management in DynamoDB, etc.).

---

## Package Structure

Simplified from the original 7+ packages:

```
packages/
├── core/           # Types, Tymbal protocol, utilities
│   ├── types/      # Channel, Message, Artifact, etc.
│   ├── tymbal/     # Frame parsing, building
│   └── utils/      # ULID, validation helpers
│
├── server/         # HTTP API + WebSocket + Agent Manager
│   ├── handlers/   # Business logic (framework-agnostic)
│   ├── adapters/   # Hono routes, Lambda handlers
│   ├── websocket/  # WebSocket connection management
│   └── agent/      # Agent lifecycle, routing
│
├── storage/        # Storage interface + implementations
│   ├── interface.ts
│   └── planetscale.ts
│
└── runtime/        # Container orchestration
    ├── interface.ts
    ├── docker.ts
    └── fargate.ts  # (if needed)
```

---

## Local Dev Experience

```bash
# Start everything
docker-compose up -d    # Starts server + deps (MySQL, etc.)

# Or without Docker for server (faster iteration)
pnpm dev               # Runs Hono server with hot reload

# Agents still use Docker
# Server talks to local Docker daemon
```

### docker-compose.yml
```yaml
services:
  server:
    build: .
    ports:
      - "3001:3001"
    environment:
      - DATABASE_URL=mysql://...
      - CONTAINER_SECRET=dev-secret
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # For agent containers

  mysql:
    image: mysql:8
    # For local PlanetScale-like experience
```

---

## Deployment Strategy

### Phase 1: Container-based (simpler)

```
Local:  docker-compose up
Prod:   ECS Fargate or Cloud Run
```

Same container, same code, same behavior. WebSocket works everywhere.

### Phase 2: Lambda optimization (if needed)

If Lambda's cost/scale benefits are needed:
1. HTTP handlers → Lambda via Hono adapter
2. WebSocket → API Gateway WebSocket + DynamoDB connections
3. Agent orchestration → Fargate (containers for claude-code)

But start with container-based. Optimize later if needed.

---

## Testing Strategy

```typescript
// Unit tests — call handlers directly
describe('createChannel', () => {
  it('spawns focus agents', async () => {
    const storage = new MockStorage();
    const ctx = { spaceId: 'test', storage };

    const channel = await createChannel(ctx, {
      name: 'my-channel',
      focusSlug: 'open',
    });

    expect(channel.name).toBe('my-channel');
    expect(storage.spawnedAgents).toContain('lead');
  });
});

// Integration tests — HTTP layer
describe('POST /channels', () => {
  it('returns 201 with channel', async () => {
    const res = await app.request('/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(201);
  });
});

// E2E tests — full stack with real containers
describe('agent flow', () => {
  it('spawns agent and receives response', async () => {
    // Create channel, send message, wait for agent frames
  });
});
```

---

## Summary

1. **Thin adapter pattern** — Business logic is framework-agnostic
2. **Hono** — Modern, multi-runtime web framework
3. **Storage interface** — Swap backends without touching handlers
4. **Container-first deployment** — Same Docker image local and prod
5. **Optimize later** — Add Lambda/Fargate only if needed

This keeps local and production in sync by design, not discipline.

---

## Implementation Phasing

Four phases, each building on the previous. Ordered by **dependency** and **core value delivery**.

### Phase 1: Agent Core

**Goal:** Containerized agents can spawn, execute, and communicate with backend.

**Why first:** Containerized agents are the core value proposition. Without this working, nothing else matters. This phase proves the fundamental architecture.

**Deliverables:**
1. Docker orchestrator (container lifecycle, env injection, volumes)
2. Container token auth (generate, verify, middleware)
3. Tymbal frame handler (parse, broadcast, persist, route)
4. Agent manager core (spawn, sendToAgent, routeMessage)
5. Minimal storage (messages table only)
6. HTTP endpoint for Tymbal frames (POST /tymbal)

**Exit criteria:**
- Spawn a claude-code container
- Container POSTs Tymbal frames to server
- Server broadcasts to WebSocket clients
- Server persists SetFrames
- @mention routing triggers agent spawn

**Risk:** Docker orchestration complexity. Mitigate by starting with simplest possible container config.

---

### Phase 2: Channel Foundation

**Goal:** Full channel and roster management with message history.

**Why second:** Agents need channels to live in. This phase provides the context for agent collaboration — where agents are, who they talk to, message history.

**Deliverables:**
1. Channel CRUD (create with focus resolution, get, list, archive)
2. Roster management (add/remove participants, leader, status)
3. Message storage (full schema, addressedAgents, pagination, agent-scoped history)
4. WebSocket streaming (connection management, sync, real-time broadcast)
5. Focus areas (system.focus resolution, auto-spawn agents)

**Dependencies:** Phase 1 (agent core must work)

**Exit criteria:**
- Create channel with focus area
- Agents auto-spawn per focus config
- Full message history with scoping
- WebSocket sync and streaming works
- Roster changes broadcast correctly

**Risk:** Message routing complexity with @mentions. Mitigate with clear routing rules and good test coverage.

---

### Phase 3: Artifacts & Board

**Goal:** Persistent collaboration artifacts with versioning and MCP access.

**Why third:** Artifacts are the persistent work products — specs, tasks, decisions. Agents need MCP tools to interact with artifacts. This is where collaboration becomes durable.

**Deliverables:**
1. Artifact CRUD (create, read, list, glob, archive)
2. Tree hierarchy (parentSlug, path computation)
3. System artifact types (system.agent, system.mcp, system.focus with props validation)
4. CAS updates (compare-and-swap for safe concurrency)
5. Versioning (optimistic concurrency, named checkpoints)
6. MCP tool interface (HTTP transport, artifact tools, message tools)
7. Resolution patterns (channel-local → root fallback)

**Dependencies:** Phase 2 (channels and roster must exist)

**Exit criteria:**
- Full artifact CRUD with tree hierarchy
- CAS prevents race conditions
- Checkpoints create immutable snapshots
- MCP tools work from agent containers
- System artifacts resolve with fallback

**Risk:** CAS complexity and MCP tool surface area. Mitigate by implementing core CRUD first, then layering CAS and MCP.

---

### Phase 4: KB, Auth & Polish

**Goal:** Knowledge base, production auth, and remaining features.

**Why last:** These are important but not foundational. KB enhances artifact utility. WorkOS enables production deployment. Structured asks and attachments round out the feature set.

**Deliverables:**
1. Knowledge base (indexing, tree navigation, keyword search, semantic search)
2. WorkOS OAuth (login flow, session management, space association)
3. Structured asks (form schema, submit handling, response routing)
4. Assets & attachments (binary upload/download, message linking)
5. Artifact WebSocket events (real-time board updates)

**Dependencies:** Phase 3 (artifacts must be complete)

**Exit criteria:**
- KB search works (keyword at minimum, semantic if feasible)
- WorkOS login flow complete
- Structured asks render and submit
- File attachments work
- Real-time artifact updates broadcast

**Risk:** Semantic search may require external service (embeddings). Mitigate by making it optional — keyword search is the baseline.

---

### Phase Dependencies Visualized

```
Phase 1: Agent Core
    │
    │  Agents can spawn and communicate
    │
    ▼
Phase 2: Channel Foundation
    │
    │  Agents have context (channels, roster, history)
    │
    ▼
Phase 3: Artifacts & Board
    │
    │  Agents can create/read persistent work products
    │
    ▼
Phase 4: KB, Auth & Polish
    │
    │  Production-ready with search and auth
    │
    ▼
  Done
```

---

### Why This Order?

1. **Value delivery:** Each phase delivers usable functionality. Phase 1 alone proves agents work. Phase 2 adds collaboration context. Phase 3 adds persistence. Phase 4 polishes for production.

2. **Risk front-loading:** The hardest parts (container orchestration, Tymbal streaming, message routing) come first. If these don't work, we find out early.

3. **Dependency respect:** Each phase builds on stable foundations. No phase requires rework of previous phases.

4. **Incremental testing:** Each phase has clear exit criteria. We can validate before moving on.

5. **Parallel work potential:** Within each phase, multiple people can work on different deliverables. Phase 1's Docker orchestrator is independent of token auth, for example.

---

### Timeline Considerations

No time estimates — that depends on team size and velocity. But some observations:

- **Phase 1** is the most uncertain — container orchestration has hidden complexity
- **Phase 2** is well-understood — standard CRUD with some routing logic
- **Phase 3** is medium complexity — CAS and MCP need care but are tractable
- **Phase 4** is mostly integration — WorkOS and KB are external services

Recommend: Get Phase 1 working end-to-end before parallelizing. The learning from Phase 1 informs everything else.
