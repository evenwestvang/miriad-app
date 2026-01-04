# Gemini CLI Integration Evaluation

## Overview

Gemini CLI is Google's open-source AI coding agent that runs in the terminal. It uses the same ReAct loop architecture as Claude Code and supports MCP servers for tool integration.

## Current PowPow Architecture

PowPow currently uses the `@anthropic-ai/claude-agent-sdk` which provides:
- `query()` function with async iterable for bi-directional messaging
- Streaming SDK messages: `system`, `assistant`, `stream_event`, `tool_progress`, `result`
- MCP server integration via SSE transport
- Session persistence via `.claude` directory

## Gemini CLI Capabilities

### Installation
```bash
npm install -g @google/gemini-cli
```

### Headless Mode

Gemini CLI supports non-interactive execution via the `-p` flag:

```bash
gemini -p "Explain the architecture of this codebase"
```

### Streaming JSON Output

The `--output-format stream-json` flag produces newline-delimited JSON events (JSONL):

```bash
gemini -p "Fix the auth bug" --output-format stream-json
```

**Event Types:**
| Event | Description |
|-------|-------------|
| `init` | Session start with `session_id` and `model` |
| `message` | User prompts and assistant responses |
| `tool_use` | Tool call requests with parameters |
| `tool_result` | Tool execution outcomes |
| `error` | Non-fatal errors/warnings |
| `result` | Final aggregated statistics |

### Approval Modes

| Flag | Behavior |
|------|----------|
| `--yolo` / `-y` | Auto-approve all actions |
| `--approval-mode auto_edit` | Allow file editing without prompts |

### MCP Support

Gemini CLI supports MCP servers, enabling the same tool integration pattern used by Claude Code.

### Agent Client Protocol (ACP)

Gemini CLI is the reference implementation for [ACP](https://agentclientprotocol.com/), a JSON-RPC 2.0 protocol for editor-agent communication. This is the same protocol used by Zed's "Bring Your Own Agent" feature.

## Feasibility Assessment

### High Feasibility

**Pros:**
1. **Similar streaming model** - JSONL events map well to PowPow's `AgentOutput` types
2. **MCP support** - Can use existing PowPow MCP server without changes
3. **Headless mode** - Designed for automation and scripting
4. **Free tier** - 60 req/min, 1000 req/day with personal Google account
5. **Open source** - Apache licensed, can study/modify implementation

**Mapping to PowPow Types:**

| Gemini Event | PowPow AgentOutput Type |
|--------------|-------------------------|
| `init` | `system` |
| `message` (assistant) | `text` |
| `tool_use` | `tool_call` |
| `tool_result` | `tool_result` |
| `error` | `error` |
| `result` | `system` |

### Challenges

1. **No SDK library** - Must spawn process and parse JSONL (vs SDK's async iterator)
2. **Session management** - No documented session resume like Claude Code's `continue: true`
3. **Input injection** - Sending follow-up messages requires stdin piping or restarting
4. **Approval flow** - May need terminal interaction for some approvals

## Implementation Approach

### Option A: Process Spawning with JSONL Parsing

```typescript
import { spawn } from 'child_process';

class GeminiAgent {
  private process: ChildProcess;

  async spawn(workdir: string, prompt: string): Promise<void> {
    this.process = spawn('gemini', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--yolo',  // Auto-approve
      '--include-directories', workdir
    ], { cwd: workdir });

    const rl = readline.createInterface({ input: this.process.stdout });

    for await (const line of rl) {
      const event = JSON.parse(line);
      this.handleEvent(event);
    }
  }

  private handleEvent(event: GeminiEvent): void {
    switch (event.type) {
      case 'init':
        this.setState('idle');
        break;
      case 'message':
        this.addOutput({ type: 'text', content: event.content });
        break;
      case 'tool_use':
        this.addOutput({ type: 'tool_call', toolName: event.name, toolInput: event.parameters });
        break;
      // ...
    }
  }
}
```

### Option B: ACP Protocol (Future)

If PowPow evolves to support ACP, Gemini CLI could be integrated as an external agent via JSON-RPC over stdio, similar to how Zed integrates it.

## Effort Estimate

| Task | Complexity |
|------|------------|
| Process spawning + JSONL parser | Low |
| Event type mapping | Low |
| MCP server connection | None (reuse existing) |
| Session persistence/resume | Medium (may need workaround) |
| Multi-turn messaging | Medium (stdin injection) |
| **Total** | **Medium** |

## Recommendation

**Feasible with moderate effort.** The main challenges are:
1. Injecting follow-up messages (stdin piping or process restart)
2. Session resume (may need to maintain context externally)

Start with a proof-of-concept using single-prompt mode with `--yolo` flag, then iterate on multi-turn capabilities.

## References

- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI Headless Docs](https://geminicli.com/docs/cli/headless)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Zed ACP Integration](https://zed.dev/blog/bring-your-own-agent-to-zed)
