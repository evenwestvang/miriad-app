/**
 * Engine Capabilities
 *
 * Defines the capability interface for agent engines (built-in and custom backends).
 * Used to determine feature support like MCP, tools, and vision.
 */

/**
 * Engine capabilities interface.
 * Declared by custom backends via --capabilities flag and hardcoded for built-ins.
 */
export interface EngineCapabilities {
  /** Can receive and connect to MCP server configs */
  supportsMcp: boolean;
  /** Supports tool calling */
  supportsTools: boolean;
  /** Can process image inputs */
  supportsVision: boolean;
  /** Can receive messages while executing */
  supportsMidTurnMessages?: boolean;
  /** Responds to agent/cancel */
  supportsInterruption?: boolean;
  /** Emits reasoning/thinking events */
  exposesReasoning?: boolean;
  /** Can restore state from session */
  supportsSessionResume?: boolean;
}

/**
 * Capability manifest returned by --capabilities flag.
 */
export interface CapabilityManifest {
  engineName: string;
  engineVersion: string;
  capabilities: EngineCapabilities;
}

/**
 * Built-in engine capabilities (hardcoded).
 * These engines are implemented directly in powpow.
 */
export const BUILTIN_ENGINE_CAPABILITIES: Record<string, EngineCapabilities> = {
  claude: {
    supportsMcp: true,
    supportsTools: true,
    supportsVision: true,
    supportsMidTurnMessages: false,
    supportsInterruption: true,
    exposesReasoning: false,
    supportsSessionResume: true,
  },
  codex: {
    supportsMcp: true,
    supportsTools: true,
    supportsVision: false,
    supportsMidTurnMessages: false,
    supportsInterruption: true,
    exposesReasoning: false,
    supportsSessionResume: true,
  },
};

/**
 * Check if an engine is built-in.
 */
export function isBuiltinEngine(engine: string): boolean {
  return engine.toLowerCase() in BUILTIN_ENGINE_CAPABILITIES;
}

/**
 * Get capabilities for a built-in engine.
 */
export function getBuiltinCapabilities(engine: string): EngineCapabilities | undefined {
  return BUILTIN_ENGINE_CAPABILITIES[engine.toLowerCase()];
}
