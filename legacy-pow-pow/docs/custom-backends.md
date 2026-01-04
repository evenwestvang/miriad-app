# Custom Agent Backends

PowPow supports custom agent backends - external binaries that implement the agent protocol. This allows you to bring your own AI agent implementation while using PowPow's coordination layer.

## Quick Start

1. Create your agent binary (see [Protocol](#protocol) below)
2. Register it in `~/.cast/backends.yaml`:

```yaml
backends:
  my-agent:
    path: /path/to/my-agent
    args:
      - "--some-flag"
```

3. Create a hat that uses it in `~/.cast/hats/my-agent.md`:

```markdown
---
name: My Custom Agent
engine: my-agent
---

Your system prompt here.
```

## Configuration

Backends are loaded from two locations (merged, user config wins):

1. **Bundled defaults:** `defaults/backends.yaml` - ships with PowPow
2. **User config:** `~/.cast/backends.yaml` - your custom backends

### backends.yaml format

Relative paths (starting with `./` or `../`) are resolved against the config file's location.

```yaml
backends:
  # Simple binary (absolute path)
  my-agent:
    path: /usr/local/bin/my-agent

  # Binary with arguments
  custom-llm:
    path: python
    args:
      - "-m"
      - "my_agent"
      - "--model=gpt-4"

  # TypeScript agent with relative path
  dev-agent:
    path: npx
    args:
      - "tsx"
      - "../examples/echo-agent/agent.ts"  # resolved from config location
```

## Protocol

Custom backends communicate with PowPow via JSON-RPC 2.0 over stdin/stdout using NDJSON framing (one JSON object per line).

### Capability Discovery (Required)

**All custom backends MUST support the `--capabilities` flag.** When invoked with this flag, the backend must output a JSON manifest to stdout and exit immediately (no full session).

```bash
my-agent --capabilities
```

Output:
```json
{
  "engineName": "my-agent",
  "engineVersion": "1.0.0",
  "capabilities": {
    "supportsMcp": true,
    "supportsTools": true,
    "supportsVision": false,
    "supportsMidTurnMessages": false,
    "supportsInterruption": true,
    "exposesReasoning": false,
    "supportsSessionResume": false
  }
}
```

PowPow probes backends on startup by running `{path} {args} --capabilities` with a 5-second timeout. Backends that don't support this flag will fail to register.

**MCP-related capabilities:**

| Capability | Type | Description |
|------------|------|-------------|
| `supportsMcp` | boolean | Can receive and connect to MCP server configs |
| `supportsTools` | boolean | Supports tool calling |
| `supportsVision` | boolean | Can process image inputs |

These capabilities determine whether PowPow will pass MCP server configurations to the backend during `agent/initialize`.

### Handshake

When spawned, your agent must immediately send a `agent/ready` notification:

```json
{"jsonrpc":"2.0","method":"agent/ready","params":{"protocolVersion":"1.0","engineName":"my-agent","engineVersion":"1.0.0","capabilities":{"supportsMidTurnMessages":false,"supportsInterruption":true,"exposesReasoning":false,"supportsSessionResume":false}}}
```

PowPow responds with `agent/initialize`:

```json
{
  "jsonrpc": "2.0",
  "method": "agent/initialize",
  "id": 1,
  "params": {
    "protocolVersion": "1.0",
    "config": {
      "workDir": "/path/to/workspace",
      "model": "claude-sonnet-4-20250514",
      "resume": false,
      "mcp": [
        {
          "slug": "github",
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": {"GITHUB_TOKEN": "resolved-actual-value"}
        },
        {
          "slug": "sanity",
          "type": "http",
          "url": "https://mcp.example.com",
          "headers": {"Authorization": "Bearer xxx"}
        }
      ]
    },
    "credentials": {},
    "mcpServers": {}
  }
}
```

**MCP Configuration** (if `supportsMcp: true`):
- `config.mcp` array contains resolved MCP server configurations
- Env var references (`${VAR_NAME}`) are already resolved to actual values
- For `stdio` type: spawn the command with given args and env
- For `http` type: connect to URL with given headers
- **Backends are responsible for establishing MCP connections** based on this config

Your agent must acknowledge:

```json
{"jsonrpc":"2.0","result":{"ok":true},"id":1}
```

### Execution

When a user sends a message, PowPow sends `agent/execute`:

```json
{"jsonrpc":"2.0","method":"agent/execute","id":2,"params":{"task":"Help me refactor this code"}}
```

Your agent streams output via notifications:

```json
{"jsonrpc":"2.0","method":"agent/output","params":{"type":"text","content":"I'll help you refactor..."}}
{"jsonrpc":"2.0","method":"agent/output","params":{"type":"text","content":"Looking at the code..."}}
{"jsonrpc":"2.0","method":"agent/progress","params":{"status":"idle"}}
```

Then responds when complete:

```json
{"jsonrpc":"2.0","result":{"status":"complete"},"id":2}
```

### Shutdown

PowPow sends `agent/shutdown` for graceful termination:

```json
{"jsonrpc":"2.0","method":"agent/shutdown","id":3}
```

Your agent should acknowledge and exit:

```json
{"jsonrpc":"2.0","result":{"ok":true},"id":3}
```

## Message Reference

### Requests (PowPow → Agent)

| Method | Description |
|--------|-------------|
| `agent/initialize` | Configuration and handshake |
| `agent/execute` | Run agent on a task |
| `agent/cancel` | Abort running execution |
| `agent/shutdown` | Graceful termination |

### Notifications (Agent → PowPow)

| Method | Description |
|--------|-------------|
| `agent/ready` | Announce readiness after spawn |
| `agent/output` | Stream text content |
| `agent/progress` | Status updates |
| `agent/tool_call` | Tool invocation request |
| `agent/tool_result` | Tool execution result |

### Capabilities

Declared in both `--capabilities` manifest and `agent/ready`:

| Capability | Type | Description |
|------------|------|-------------|
| `supportsMcp` | boolean | Can receive and connect to MCP server configs |
| `supportsTools` | boolean | Supports tool calling |
| `supportsVision` | boolean | Can process image inputs |
| `supportsMidTurnMessages` | boolean | Can receive messages while executing |
| `supportsInterruption` | boolean | Responds to `agent/cancel` |
| `exposesReasoning` | boolean | Emits reasoning/thinking events |
| `supportsSessionResume` | boolean | Can restore state from session |

## Example Implementation

See `examples/echo-agent/` for a minimal TypeScript implementation:

```typescript
// Capability manifest (shared between --capabilities and agent/ready)
const CAPABILITIES_MANIFEST = {
  engineName: "my-agent",
  engineVersion: "1.0.0",
  capabilities: {
    supportsMcp: false,
    supportsTools: false,
    supportsVision: false,
    supportsMidTurnMessages: false,
    supportsInterruption: true,
    exposesReasoning: false,
    supportsSessionResume: false,
  },
};

// Handle --capabilities flag (required)
if (process.argv.includes("--capabilities")) {
  console.log(JSON.stringify(CAPABILITIES_MANIFEST));
  process.exit(0);
}

// Announce readiness
notify("agent/ready", {
  protocolVersion: "1.0",
  ...CAPABILITIES_MANIFEST,
});

// Handle messages
for await (const line of readline) {
  const msg = JSON.parse(line);

  switch (msg.method) {
    case "agent/initialize":
      // MCP config is available at msg.params.config.mcp (if supportsMcp: true)
      respond(msg.id, { ok: true });
      break;

    case "agent/execute":
      notify("agent/output", { type: "text", content: "Working..." });
      notify("agent/progress", { status: "idle" });
      respond(msg.id, { status: "complete" });
      break;

    case "agent/shutdown":
      respond(msg.id, { ok: true });
      process.exit(0);
  }
}
```

## Debugging

- Your agent can write to stderr for logging (not captured by PowPow)
- Use `--verbose` or similar flags in your agent for debug output
- Test your agent manually: `echo '{"jsonrpc":"2.0","method":"agent/shutdown","id":1}' | your-agent`

## Limitations

- No binary payload support (use base64 for binary data)
- Single agent instance per channel
