/**
 * Claude SDK Engine
 *
 * In-process engine using the Claude Code SDK. This is the default engine
 * and wraps the existing SDK query() function to emit SDKMessages.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEngine,
  EngineConfig,
  EngineProcess,
  EngineProcessState,
  EngineMessage,
} from './types.js';
import type { McpServerConfig } from '../types.js';

// =============================================================================
// URL Rewriting for Docker
// =============================================================================

function isRunningInDocker(): boolean {
  const config = process.env.MIRIAD_CONFIG;
  if (!config) return false;
  return config.includes('host.docker.internal');
}

function rewriteUrlForDocker(url: string): string {
  if (!isRunningInDocker()) return url;
  return url.replace(/localhost/g, 'host.docker.internal');
}

// =============================================================================
// Message Stream (for mid-turn injection)
// =============================================================================

interface MessageStream {
  push(content: string, sender?: string): void;
  close(): void;
  iterable: AsyncIterable<SDKUserMessage>;
  sessionId: string;
}

function createMessageStream(initialContent: string, initialSender?: string): MessageStream {
  const sessionId = randomUUID();
  const queue: Array<{ content: string; sender?: string }> = [];
  let closed = false;
  let resolveWaiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;

  function makeMessage(content: string, sender?: string): SDKUserMessage {
    const formatted = sender ? `--- @${sender} says:\n${content}` : content;
    return {
      type: 'user',
      message: { role: 'user', content: formatted },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  return {
    sessionId,

    push(content: string, sender?: string): void {
      if (closed) {
        console.warn('[MessageStream] Cannot push to closed stream');
        return;
      }
      queue.push({ content, sender });

      if (resolveWaiting && queue.length > 0) {
        const items = queue.splice(0);
        const batched = items.map(i => i.sender ? `--- @${i.sender} says:\n${i.content}` : i.content).join('\n\n');
        resolveWaiting({ value: makeMessage(batched), done: false });
        resolveWaiting = null;
      }
    },

    close(): void {
      closed = true;
      if (resolveWaiting) {
        resolveWaiting({ value: undefined as unknown as SDKUserMessage, done: true });
        resolveWaiting = null;
      }
    },

    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        let yieldedInitial = false;

        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (!yieldedInitial) {
              yieldedInitial = true;
              return { value: makeMessage(initialContent, initialSender), done: false };
            }

            if (closed && queue.length === 0) {
              return { value: undefined as unknown as SDKUserMessage, done: true };
            }

            if (queue.length > 0) {
              const items = queue.splice(0);
              const batched = items.map(i => i.sender ? `--- @${i.sender} says:\n${i.content}` : i.content).join('\n\n');
              return { value: makeMessage(batched), done: false };
            }

            return new Promise((resolve) => {
              resolveWaiting = resolve;
            });
          },
        };
      },
    },
  };
}

// =============================================================================
// Claude SDK Engine Process
// =============================================================================

class ClaudeSDKProcess implements EngineProcess {
  readonly pid = null; // In-process, no separate PID

  private _state: EngineProcessState = 'starting';
  private messageStream: MessageStream | null = null;
  private exitHandlers: Array<(code: number | null) => void> = [];
  private outputQueue: SDKMessage[] = [];
  private outputResolve: ((value: IteratorResult<SDKMessage>) => void) | null = null;
  private outputDone = false;

  constructor(
    private readonly config: EngineConfig,
    private readonly onError?: (error: Error) => void,
  ) {}

  get state(): EngineProcessState {
    return this._state;
  }

  /**
   * Start processing a message. Called by the engine after spawn.
   */
  async start(content: string, sender?: string): Promise<void> {
    this._state = 'busy';

    const workspace = this.config.workspacePath;
    const claudeConfigDir = join(workspace, '.claude');
    const shouldContinue = existsSync(claudeConfigDir);

    console.log(`[ClaudeSDKProcess] Starting for ${this.config.agentId}`);
    console.log(`[ClaudeSDKProcess] Working directory: ${workspace}`);
    console.log(`[ClaudeSDKProcess] Continue session: ${shouldContinue}`);

    const options: Options = {
      model: 'claude-opus-4-5-20251101',
      systemPrompt: this.config.systemPrompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: this.config.systemPrompt,
          }
        : {
            type: 'preset',
            preset: 'claude_code',
          },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      continue: shouldContinue,
      cwd: workspace,
      settingSources: [],
      env: {
        ...this.config.environment,
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !['PWD', 'OLDPWD'].includes(key))
        ),
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    };

    // Add MCP servers if configured
    if (this.config.mcpServers && this.config.mcpServers.length > 0) {
      const mcpServers = this.buildMcpConfig(this.config.mcpServers);
      if (Object.keys(mcpServers).length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options.mcpServers = mcpServers as any;
      }
    }

    // Create message stream for mid-turn injection
    this.messageStream = createMessageStream(content, sender);

    try {
      const q = query({
        prompt: this.messageStream.iterable,
        options,
      });

      for await (const message of q) {
        this.emitOutput(message);
      }

      console.log(`[ClaudeSDKProcess] Query completed for ${this.config.agentId}`);
    } catch (error) {
      console.error(`[ClaudeSDKProcess] Query error for ${this.config.agentId}:`, error);
      this.onError?.(error as Error);
    } finally {
      this.messageStream?.close();
      this.messageStream = null;
      this._state = 'ready';
      this.finishOutput();
    }
  }

  private buildMcpConfig(servers: McpServerConfig[]): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {};

    for (const server of servers) {
      if (server.transport === 'stdio') {
        const rewrittenEnv = server.env
          ? Object.fromEntries(
              Object.entries(server.env).map(([key, value]) => [
                key,
                typeof value === 'string' ? rewriteUrlForDocker(value) : value,
              ])
            )
          : undefined;
        mcpServers[server.name] = {
          type: 'stdio' as const,
          command: server.command,
          args: server.args,
          env: rewrittenEnv,
          cwd: server.cwd,
        };
      } else if ((server.transport === 'sse' || server.transport === 'http') && server.url) {
        mcpServers[server.name] = {
          type: server.transport as 'sse' | 'http',
          url: rewriteUrlForDocker(server.url),
          headers: server.headers,
        };
      }
    }

    return mcpServers;
  }

  private emitOutput(message: SDKMessage): void {
    if (this.outputResolve) {
      this.outputResolve({ value: message, done: false });
      this.outputResolve = null;
    } else {
      this.outputQueue.push(message);
    }
  }

  private finishOutput(): void {
    this.outputDone = true;
    if (this.outputResolve) {
      this.outputResolve({ value: undefined as unknown as SDKMessage, done: true });
      this.outputResolve = null;
    }
  }

  send(message: EngineMessage): void {
    if (message.type === 'user' && message.content && this.messageStream) {
      // Mid-turn message injection
      this.messageStream.push(message.content, message.sender);
    } else if (message.type === 'control' && message.action === 'heartbeat') {
      // Heartbeat - SDK doesn't need explicit handling, just acknowledge
      // The TymbalBridge will handle emitting heartbeat_ack
    }
    // Note: interrupt not supported for in-process SDK
  }

  get output(): AsyncIterable<SDKMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return {
          async next(): Promise<IteratorResult<SDKMessage>> {
            if (self.outputQueue.length > 0) {
              return { value: self.outputQueue.shift()!, done: false };
            }
            if (self.outputDone) {
              return { value: undefined as unknown as SDKMessage, done: true };
            }
            return new Promise((resolve) => {
              self.outputResolve = resolve;
            });
          },
        };
      },
    };
  }

  async terminate(reason?: string): Promise<void> {
    console.log(`[ClaudeSDKProcess] Terminating: ${reason ?? 'no reason'}`);
    this.messageStream?.close();
    this._state = 'terminated';
    this.finishOutput();
    for (const handler of this.exitHandlers) {
      handler(0);
    }
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }
}

// =============================================================================
// Claude SDK Engine
// =============================================================================

export class ClaudeSDKEngine implements AgentEngine {
  readonly engineId = 'claude-sdk';
  readonly displayName = 'Claude Code SDK';

  async isAvailable(): Promise<boolean> {
    // Always available - it's in-process
    return true;
  }

  async spawn(config: EngineConfig): Promise<EngineProcess> {
    const process = new ClaudeSDKProcess(config);
    // Note: The process is created but not started yet.
    // The AgentManager will call methods to start processing.
    return process;
  }
}

/**
 * Start processing a message on a ClaudeSDKProcess.
 * This is called by AgentManager after spawning.
 */
export function startClaudeSDKProcess(
  process: EngineProcess,
  content: string,
  sender?: string,
): Promise<void> {
  if (process instanceof ClaudeSDKProcess) {
    return process.start(content, sender);
  }
  throw new Error('Not a ClaudeSDKProcess');
}
