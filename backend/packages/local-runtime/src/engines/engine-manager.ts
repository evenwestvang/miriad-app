/**
 * Engine Manager
 *
 * Registry for agent engines. Handles engine selection based on agent
 * configuration and provides access to registered engines.
 */

import type { AgentEngine, EngineId } from './types.js';
import { DEFAULT_ENGINE_ID } from './types.js';

export class EngineManager {
  private readonly engines = new Map<string, AgentEngine>();

  /**
   * Register an engine implementation.
   */
  register(engine: AgentEngine): void {
    if (this.engines.has(engine.engineId)) {
      console.warn(`[EngineManager] Overwriting existing engine: ${engine.engineId}`);
    }
    this.engines.set(engine.engineId, engine);
    console.log(`[EngineManager] Registered engine: ${engine.engineId} (${engine.displayName})`);
  }

  /**
   * Get engine by ID.
   */
  getEngine(engineId: string): AgentEngine | undefined {
    return this.engines.get(engineId);
  }

  /**
   * Select engine based on engine ID, with fallback to default.
   */
  selectEngine(engineId?: string): AgentEngine {
    const id = engineId ?? DEFAULT_ENGINE_ID;
    const engine = this.engines.get(id);

    if (!engine) {
      // Fall back to default engine if requested engine not found
      const defaultEngine = this.engines.get(DEFAULT_ENGINE_ID);
      if (!defaultEngine) {
        throw new Error(`No engines registered. Cannot select engine: ${id}`);
      }
      console.warn(`[EngineManager] Engine '${id}' not found, falling back to '${DEFAULT_ENGINE_ID}'`);
      return defaultEngine;
    }

    return engine;
  }

  /**
   * List all registered engines.
   */
  listEngines(): AgentEngine[] {
    return Array.from(this.engines.values());
  }

  /**
   * Check which engines are available (async availability check).
   */
  async getAvailableEngines(): Promise<AgentEngine[]> {
    const results = await Promise.all(
      Array.from(this.engines.values()).map(async (engine) => {
        const available = await engine.isAvailable();
        return available ? engine : null;
      })
    );
    return results.filter((e): e is AgentEngine => e !== null);
  }
}
