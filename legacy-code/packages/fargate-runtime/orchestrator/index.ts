/**
 * Orchestrator Module Exports
 *
 * Lambda handlers and utilities for managing Fargate Claude Code containers.
 */

// Lambda handlers
export { handler, orchestratorHandler, stopContainerHandler } from "./handler.js";

// Container state operations
export {
  getContainerState,
  createContainerState,
  setContainerRunning,
  setContainerStopping,
  setContainerStopped,
  touchContainerActivity,
  deleteContainerState,
  isContainerReady,
  type ContainerState,
  type ContainerStatus,
} from "./container-state.js";

// ECS task operations
export {
  startTask,
  stopTask,
  describeTask,
  waitForTaskHealthy,
  sendMessageToContainer,
  type StartTaskResult,
  type TaskInfo,
} from "./ecs-tasks.js";
