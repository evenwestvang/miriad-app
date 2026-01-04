# Cursor CLI Integration Evaluation

## Overview

Cursor CLI is the headless version of the Cursor AI code editor. It provides terminal-based agent capabilities but has several rough edges that make integration more challenging than other options.

## Current PowPow Architecture

PowPow uses `@anthropic-ai/claude-agent-sdk` with:
- Async iterable for bi-directional messaging
- Clean session management with abort controllers
- MCP server integration

## Cursor CLI Capabilities

### Installation

```bash
curl https://cursor.com/install -fsSL | bash
```

### Basic Usage

```bash
cursor-agent chat "find one bug and fix it"
```

### Print Mode (Non-Interactive)

```bash
cursor-agent -p "analyze this codebase"
cursor-agent --print "refactor the auth module"
```

**Flags:**
| Flag | Purpose |
|------|---------|
| `-p` / `--print` | Non-interactive mode for scripting |
| `--force` | Allow file changes without confirmation |
| `--stream-partial-output` | Incremental streaming of deltas |

### Output Formats

| Format | Flag | Description |
|--------|------|-------------|
| Text | (default) | Human-readable responses |
| JSON | `--json` | Structured analysis data |
| Stream-JSON | `--stream-json` | Message-level progress tracking |

### Authentication

Requires `CURSOR_API_KEY` environment variable. API key available from:
https://cursor.com/dashboard?tab=background-agents

**Note:** Free plan API keys only work for headless CLI, not Background Agent API.

## Known Limitations

Based on community reports and documentation:

1. **Process Hanging** - Even with `-p` (print) flag, the process doesn't release the terminal. Requires CTRL+C to regain control.

2. **No Stdin Pipe** - Cannot read prompts from file or stdin pipe in a practical way.

3. **Trust Issues** - CLI may require an initial interactive session to:
   - Enable MCP usage
   - "Trust" the working directory

4. **MCP Bootstrap** - MCP servers may not work without prior interactive setup.

## Feasibility Assessment

### Medium Feasibility

**Pros:**
1. **Streaming JSON** - Real-time progress tracking available
2. **Force mode** - File changes without confirmation
3. **Any model** - Works with any model in Cursor subscription
4. **Familiar patterns** - Similar to other CLI agents

**Cons:**
1. **Process hanging** - Major issue for automation
2. **No session resume** - No documented way to continue sessions
3. **Stdin limitations** - Multi-turn conversation difficult
4. **Trust/MCP setup** - May require manual intervention
5. **Beta status** - CLI still labeled as beta, expect rough edges
6. **No SDK** - Must use process spawning

**Event Mapping (Theoretical):**

| Cursor Event | PowPow Type |
|--------------|-------------|
| Message start | `text` |
| Tool call | `tool_call` |
| File change | `tool_call` |
| Error | `error` |
| Complete | `system` |

## Implementation Approach

### Option A: Process Spawning with Workarounds

```typescript
import { spawn } from 'child_process';

class CursorAgent {
  private process: ChildProcess;
  private killTimeout: NodeJS.Timeout;

  async spawn(workdir: string, prompt: string): Promise<void> {
    this.process = spawn('cursor-agent', [
      '-p', prompt,
      '--force',
      '--stream-json'
    ], {
      cwd: workdir,
      env: { ...process.env, CURSOR_API_KEY: apiKey }
    });

    const rl = readline.createInterface({ input: this.process.stdout });

    for await (const line of rl) {
      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        // Text output, not JSON
        this.handleText(line);
      }
    }

    // Workaround: Kill process after completion detected
    this.scheduleCleanup();
  }

  private scheduleCleanup(): void {
    // Process may hang - force kill after idle period
    this.killTimeout = setTimeout(() => {
      this.process.kill('SIGTERM');
    }, 5000);
  }
}
```

### Option B: Background Agent API (If Available)

Cursor mentions a "Background Agent API" for Pro/Business plans that might provide better programmatic control:

```typescript
// Hypothetical - API not documented
const cursor = new CursorBackground({ apiKey });
const agent = await cursor.createAgent({ workdir, prompt });
for await (const event of agent.stream()) {
  handleEvent(event);
}
```

This API is not publicly documented, but could be explored.

## Workarounds for Known Issues

### Process Hanging

```typescript
// Monitor output for completion signals
process.stdout.on('data', (data) => {
  if (isCompletionSignal(data)) {
    setTimeout(() => process.kill(), 1000);
  }
});

// Or use timeout-based cleanup
const IDLE_TIMEOUT = 10000;
let lastActivity = Date.now();

process.stdout.on('data', () => {
  lastActivity = Date.now();
});

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT) {
    process.kill();
  }
}, 1000);
```

### Multi-Turn Messaging

Without stdin support, options are limited:
1. **Restart process** - Each message spawns new process
2. **Context injection** - Include history in prompt
3. **External state** - Use files to maintain context

## Effort Estimate

| Task | Complexity |
|------|------------|
| Process spawning | Low |
| JSONL parsing | Low |
| Event mapping | Medium (less documented) |
| Process hanging workaround | Medium |
| Multi-turn messaging | High |
| MCP setup/trust | Unknown |
| Session management | High (no built-in support) |
| **Total** | **High** |

## Recommendation

**Feasible but not recommended as first integration.** The rough edges (process hanging, no stdin, beta status) make Cursor CLI the most challenging option. Consider:

1. **Wait for maturity** - CLI is in beta, issues may be resolved
2. **Explore Background Agent API** - May provide cleaner integration
3. **Prioritize Codex/Gemini** - More mature programmatic interfaces

If integration is required:
- Start with single-prompt mode
- Implement aggressive process cleanup
- Use context injection for conversation history
- Accept that session resume won't work natively

## Alternative: Cursor as MCP Client

Instead of integrating Cursor as an agent backend, consider using Cursor as a frontend that connects to PowPow's MCP server - making PowPow tools available within Cursor's normal operation.

## References

- [Cursor CLI Headless Docs](https://cursor.com/docs/cli/headless)
- [Cursor CLI Blog Post](https://cursor.com/blog/cli)
- [Community Forum Discussion](https://forum.cursor.com/t/api-for-headless-control-of-cursor/41165)
- [Known Bug: Terminal Not Released](https://forum.cursor.com/t/cursor-cli-headless-mode-does-not-release-the-terminal/133624)
