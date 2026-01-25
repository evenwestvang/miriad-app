/**
 * Nuum Engine
 *
 * Subprocess engine running @miriad-systems/nuum via bunx.
 * Communicates via NDJSON over stdin/stdout, translates to SDKMessage format.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEngine,
  EngineConfig,
  EngineProcess,
  EngineProcessState,
  EngineMessage,
} from './types.js';

// =============================================================================
// NDJSON Message Types (from Nuum protocol)
// =============================================================================

interface NuumUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  session_id?: string;
  system_prompt?: string;
  // Nuum expects mcp_servers as an object keyed by server name
  mcp_servers?: Record<string, {
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
}

interface NuumControlMessage {
  type: 'control';
  action: 'interrupt' | 'heartbeat';
}

type NuumInputMessage = NuumUserMessage | NuumControlMessage;

// =============================================================================
// Nuum Engine Process
// =============================================================================

class NuumProcess implements EngineProcess {
  private proc: ChildProcess | null = null;
  private _state: EngineProcessState = 'starting';
  private exitHandlers: Array<(code: number | null) => void> = [];
  private outputQueue: SDKMessage[] = [];
  private outputResolve: ((value: IteratorResult<SDKMessage>) => void) | null = null;
  private outputDone = false;
  private sessionId: string | null = null;

  constructor(private readonly config: EngineConfig) {}

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get state(): EngineProcessState {
    return this._state;
  }

  /**
   * Spawn the Nuum subprocess.
   */
  async spawn(): Promise<void> {
    const dbPath = join(this.config.workspacePath, '.nuum', 'agent.db');

    console.log(`[NuumProcess] Spawning for ${this.config.agentId}`);
    console.log(`[NuumProcess] DB path: ${dbPath}`);
    console.log(`[NuumProcess] Working directory: ${this.config.workspacePath}`);

    // Build environment
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.config.environment,
    };

    // Pass initial MCP config via environment
    if (this.config.mcpServers && this.config.mcpServers.length > 0) {
      env.MIRIAD_MCP_CONFIG = JSON.stringify({
        mcpServers: Object.fromEntries(
          this.config.mcpServers.map(s => [s.name, s])
        ),
      });
    }

    this.proc = spawn('bunx', [
      '@miriad-systems/nuum@latest',
      '--stdio',
      '--db', dbPath,
    ], {
      cwd: this.config.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout (NDJSON messages)
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => {
      this.handleLine(line);
    });

    // Handle stderr (logging)
    this.proc.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.log(`[NuumProcess:${this.config.agentId}] ${text}`);
      }
    });

    // Handle exit
    this.proc.on('exit', (code) => {
      console.log(`[NuumProcess] Exited with code ${code}`);
      this._state = 'terminated';
      this.finishOutput();
      for (const handler of this.exitHandlers) {
        handler(code);
      }
    });

    this.proc.on('error', (error) => {
      console.error(`[NuumProcess] Spawn error:`, error);
      this._state = 'terminated';
      this.finishOutput();
    });

    // Wait for init message
    await this.waitForInit();
  }

  private async waitForInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for Nuum init message'));
      }, 30000);

      const checkInit = () => {
        if (this._state === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (this._state === 'terminated') {
          clearTimeout(timeout);
          reject(new Error('Nuum process terminated before init'));
        } else {
          setTimeout(checkInit, 100);
        }
      };
      checkInit();
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: SDKMessage;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.warn(`[NuumProcess] Invalid JSON: ${line}`);
      return;
    }
    
    console.log(`[NuumProcess] Received: ${JSON.stringify(msg).slice(0, 200)}`);

    // Handle init message
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      const initMsg = msg as { session_id?: string };
      this.sessionId = initMsg.session_id ?? null;
      this._state = 'ready';
      console.log(`[NuumProcess] Initialized, session: ${this.sessionId}`);
      // Don't emit init to output - it's internal
      return;
    }

    // Handle result message (turn complete)
    if (msg.type === 'result') {
      this._state = 'ready';
    }

    // Translate and emit
    const translated = this.translateMessage(msg);
    if (translated) {
      this.emitOutput(translated);
    }
  }

  /**
   * Translate Nuum message to SDK format.
   * Most messages are already SDK-compatible, we just pass them through.
   * The TymbalBridge handles the actual translation to Tymbal frames.
   */
  private translateMessage(msg: SDKMessage): SDKMessage | null {
    // Nuum emits SDK-compatible messages, pass through as-is
    // The TymbalBridge will handle any missing fields gracefully
    return msg;
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
    if (!this.proc?.stdin?.writable) {
      console.warn('[NuumProcess] Cannot send: stdin not writable');
      return;
    }

    if (message.type === 'user' && message.content) {
      const formatted = message.sender
        ? `--- @${message.sender} says:\n${message.content}`
        : message.content;

      const nuumMsg: NuumUserMessage = {
        type: 'user',
        message: { role: 'user', content: formatted },
        session_id: this.sessionId ?? undefined,
      };

      // Include per-turn overrides if provided
      if (message.systemPrompt) {
        nuumMsg.system_prompt = message.systemPrompt;
      }
      if (message.mcpServers && message.mcpServers.length > 0) {
        // Convert array to object keyed by name (Nuum's expected format)
        nuumMsg.mcp_servers = Object.fromEntries(
          message.mcpServers.map(s => [s.name, s])
        );
      }

      this._state = 'busy';
      console.log(`[NuumProcess] Sending user message: ${formatted.slice(0, 100)}...`);
      this.proc.stdin.write(JSON.stringify(nuumMsg) + '\n');
    } else if (message.type === 'control') {
      const nuumMsg: NuumControlMessage = {
        type: 'control',
        action: message.action!,
      };
      this.proc.stdin.write(JSON.stringify(nuumMsg) + '\n');
    }
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
    console.log(`[NuumProcess] Terminating: ${reason ?? 'no reason'}`);

    if (this.proc && !this.proc.killed) {
      // Send SIGTERM for graceful shutdown
      this.proc.kill('SIGTERM');

      // Wait a bit, then force kill if needed
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.proc && !this.proc.killed) {
            console.log('[NuumProcess] Force killing after timeout');
            this.proc.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.proc!.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this._state = 'terminated';
    this.finishOutput();
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }
}

// =============================================================================
// Nuum Engine
// =============================================================================

export class NuumEngine implements AgentEngine {
  readonly engineId = 'nuum';
  readonly displayName = 'Nuum (Miriad Code)';

  async isAvailable(): Promise<boolean> {
    try {
      // Check if bunx is available
      const { execSync } = await import('node:child_process');
      execSync('bunx --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async spawn(config: EngineConfig): Promise<EngineProcess> {
    const process = new NuumProcess(config);
    await process.spawn();
    return process;
  }
}
