/**
 * @cast/runtime - Agent runtime for containers
 *
 * Provides container lifecycle management for running claude-code agents.
 * Local development uses Docker, production uses Fly.io.
 */

// Types
export type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  AgentStatus,
  AgentMessage,
  ContainerInfo,
  RuntimeType,
  McpServerConfig,
  RuntimeEvent,
  RuntimeEventHandler,
  AgentId,
} from './types.js';

// Identity utilities
export { formatAgentId, parseAgentId, validateAgentId } from './types.js';

// Docker implementation (local development)
export { DockerRuntime, type DockerRuntimeConfig } from './docker-orchestrator.js';

// Fly.io implementation (production)
export { FlyRuntime, type FlyRuntimeConfig } from './fly-runtime.js';

// Mock implementation (testing)
export {
  MockAgentRuntime,
  createMockRuntime,
  type MockRuntimeOptions,
  type ActivateCall,
  type SendMessageCall,
} from './mock-orchestrator.js';
