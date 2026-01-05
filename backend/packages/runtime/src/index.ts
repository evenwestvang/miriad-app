/**
 * @cast/runtime - Container orchestration for agents
 *
 * Provides container lifecycle management for running claude-code agents.
 * Local development uses Docker, production uses AWS Fargate.
 */

// Types
export type {
  ContainerOrchestrator,
  ContainerSpawnOptions,
  ContainerState,
  ContainerStatus,
  McpServerConfig,
  OrchestratorEvent,
  OrchestratorEventHandler,
} from './types.js';

// Docker implementation (local development)
export { DockerOrchestrator, type DockerOrchestratorConfig } from './docker-orchestrator.js';

// Fargate implementation (AWS production)
export { FargateOrchestrator, type FargateOrchestratorConfig } from './fargate-orchestrator.js';

// Mock implementation (testing)
export {
  MockContainerOrchestrator,
  createMockOrchestrator,
  type MockOrchestratorOptions,
  type SpawnCall,
  type SendMessageCall,
} from './mock-orchestrator.js';
