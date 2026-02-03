/**
 * Agent Engines
 *
 * Pluggable engine system for running different agent implementations.
 */

export * from './types.js';
export { EngineManager } from './engine-manager.js';
export { ClaudeSDKEngine, startClaudeSDKProcess } from './claude-sdk-engine.js';
export { NuumEngine } from './nuum-engine.js';

import { EngineManager } from './engine-manager.js';
import { ClaudeSDKEngine } from './claude-sdk-engine.js';
import { NuumEngine } from './nuum-engine.js';

export interface EngineManagerOptions {
  /** Custom nuum executable command (default: bunx @sanity-labs/nuum@latest) */
  nuumExecutable?: string;
}

/**
 * Create and configure the default engine manager with all available engines.
 */
export function createEngineManager(options?: EngineManagerOptions): EngineManager {
  const manager = new EngineManager();

  // Register default engines
  manager.register(new ClaudeSDKEngine());
  manager.register(new NuumEngine(options?.nuumExecutable));

  return manager;
}
