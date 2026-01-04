# OpenAI Codex Integration Evaluation

## Overview

OpenAI Codex is a lightweight coding agent available as both a CLI tool and a TypeScript SDK. It provides the closest integration model to Claude Code's SDK, making it the most straightforward candidate for PowPow integration.

## Current PowPow Architecture

PowPow uses `@anthropic-ai/claude-agent-sdk`:
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({ prompt: asyncIterable, options });
for await (const message of q) {
  handleMessage(message);
}
```

## Codex Capabilities

### TypeScript SDK

```bash
npm install @openai/codex-sdk
```

**Usage pattern mirrors Claude Code SDK:**
```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run("Your task here");
```

### CLI Non-Interactive Mode

```bash
codex exec "fix the authentication bug"
```

**Flags:**
| Flag | Purpose |
|------|---------|
| `--full-auto` | Allow file editing |
| `--sandbox danger-full-access` | Enable network access |
| `--json` | Stream JSONL events |
| `--output-schema <path>` | Structured JSON output |
| `--skip-git-repo-check` | Skip git requirement |

### Streaming JSON Events

```bash
codex exec --json "summarize the repo" | jq
```

**Event Types:**
| Event | Description |
|-------|-------------|
| `thread.started` | Session initialized with `thread_id` |
| `turn.started` | Turn begins |
| `item.started` | Thread item started |
| `item.updated` | Thread item updated |
| `item.completed` | Thread item finished |
| `turn.completed` | Turn finished (includes token usage) |
| `turn.failed` | Turn failed with error details |
| `error` | Unrecoverable stream error |

**Item Types:**
| Type | Description |
|------|-------------|
| `agent_message` | Assistant text response |
| `reasoning` | Thinking/reasoning summary |
| `command_execution` | Shell command with output |
| `file_change` | File modifications |
| `mcp_tool_call` | MCP tool invocation |
| `web_search` | Web search operations |
| `todo_list` | Agent's evolving plan |

**Sample JSONL Output:**
```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

### Session Resume

```bash
# Resume last session
codex exec resume --last "continue with the next step"

# Resume specific session
codex exec resume <SESSION_ID>
```

### MCP Support

Codex supports MCP servers, so the existing PowPow MCP server can be used directly.

## Feasibility Assessment

### Very High Feasibility

**Pros:**
1. **TypeScript SDK** - Native integration pattern, no process spawning needed
2. **Thread-based model** - Similar to Claude Code's session management
3. **Session resume** - Built-in support via `resume` command
4. **Rich event types** - `command_execution`, `file_change`, `reasoning` provide detailed activity
5. **MCP support** - Existing PowPow MCP server works as-is
6. **Token usage tracking** - `turn.completed` includes usage metrics

**Event Mapping to PowPow:**

| Codex Event/Item | PowPow AgentOutput Type |
|------------------|-------------------------|
| `thread.started` | `system` |
| `agent_message` | `text` |
| `command_execution` | `tool_call` + `tool_result` |
| `file_change` | `tool_call` |
| `mcp_tool_call` | `tool_call` |
| `reasoning` | `text` (thinking) |
| `error` / `turn.failed` | `error` |

### Minimal Challenges

1. **API key required** - OpenAI account needed
2. **Different SDK interface** - `thread.run()` vs `query(prompt, options)`

## Implementation Approach

### Option A: TypeScript SDK (Recommended)

Create a `CodexAgentManager` parallel to `AgentManager`:

```typescript
import { Codex } from "@openai/codex-sdk";

interface CodexAgent {
  name: string;
  channel: string;
  thread: CodexThread;
  // ...
}

class CodexAgentManager {
  private codex = new Codex();
  private agents = new Map<string, CodexAgent>();

  async spawn(channel: string, name: string, mcpUrl: string): Promise<void> {
    const thread = this.codex.startThread({
      model: "gpt-5.2-codex",
      mcpServers: {
        powpow: { type: "sse", url: mcpUrl }
      }
    });

    // Initial prompt
    const result = await thread.run(
      `You are "${name}", an AI agent in #${channel}. Track the channel and introduce yourself.`
    );

    // Handle streaming events
    for await (const event of result.stream) {
      this.handleEvent(agent, event);
    }
  }

  sendMessage(channel: string, name: string, content: string): void {
    const agent = this.getAgent(channel, name);
    // Continue thread with new message
    agent.thread.run(content);
  }
}
```

### Option B: CLI with JSONL (Fallback)

If SDK doesn't expose full streaming, use CLI:

```typescript
import { spawn } from 'child_process';

const proc = spawn('codex', [
  'exec', '--json', '--full-auto',
  `You are "${name}" in #${channel}...`
], { cwd: workdir, env: { CODEX_API_KEY: apiKey } });

// Parse JSONL stream
const rl = readline.createInterface({ input: proc.stdout });
for await (const line of rl) {
  const event = JSON.parse(line);
  this.handleEvent(event);
}

// Resume for follow-up messages
spawn('codex', ['exec', 'resume', '--last', nextMessage], ...);
```

## Effort Estimate

| Task | Complexity |
|------|------------|
| SDK integration | Low |
| Event mapping | Low |
| MCP connection | None (reuse existing) |
| Session/thread management | Low (built-in) |
| Multi-turn messaging | Low (thread.run) |
| Agent abstraction layer | Medium |
| **Total** | **Low-Medium** |

## Agent Abstraction

To support multiple agent backends, create an interface:

```typescript
interface CodingAgent {
  spawn(channel: string, name: string, options: AgentOptions): Promise<void>;
  sendMessage(channel: string, name: string, content: string): void;
  kick(channel: string, name: string): void;
  getState(): AgentState;
  getOutput(): AgentOutput[];
}

// Implementations
class ClaudeCodeAgent implements CodingAgent { ... }
class CodexAgent implements CodingAgent { ... }
class GeminiAgent implements CodingAgent { ... }
```

## Recommendation

**Highly feasible - best candidate for integration.** The TypeScript SDK provides a native integration path with minimal friction. The event model is rich enough to provide detailed activity tracking, and session management is built-in.

**Suggested approach:**
1. Start with SDK integration
2. Create `CodingAgent` abstraction interface
3. Implement `CodexAgent` alongside existing `AgentManager`
4. Add agent type selection to spawn API

## References

- [Codex SDK Documentation](https://developers.openai.com/codex/sdk/)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/)
- [Codex exec Documentation](https://github.com/openai/codex/blob/main/docs/exec.md)
- [OpenAI Codex GitHub](https://github.com/openai/codex)
