# Echo Agent

Minimal reference implementation of a PowPow custom backend.

## Usage

Register in `defaults/backends.yaml`:

```yaml
backends:
  echo-agent:
    path: npx
    args:
      - "tsx"
      - "/path/to/powpow/examples/echo-agent/agent.ts"
```

Create a hat that uses it in `defaults/hats/echo.md`:

```markdown
---
name: Echo Bot
engine: echo-agent
---

You are a simple echo agent for testing.
```

## Protocol

The agent implements JSON-RPC 2.0 over stdin/stdout with NDJSON framing.

### Handshake

1. Agent → PowPow: `agent/ready` notification with capabilities
2. PowPow → Agent: `agent/initialize` request with config
3. Agent → PowPow: Response `{ok: true}`

### Execution

1. PowPow → Agent: `agent/execute` request with task
2. Agent → PowPow: `agent/output` notifications (streaming)
3. Agent → PowPow: `agent/progress` notification (idle)
4. Agent → PowPow: Response `{status: "complete"}`

### Shutdown

1. PowPow → Agent: `agent/shutdown` request
2. Agent → PowPow: Response `{ok: true}`
3. Agent exits
