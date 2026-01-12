/**
 * Runtime management for local runtimes.
 */

export {
  createRuntimeConnectionManager,
  type RuntimeConnectionManager,
  type RuntimeConnectionManagerOptions,
  // Protocol message types
  type BackendToRuntimeMessage,
  type RuntimeToBackendMessage,
  type RuntimeConnectedMessage,
  type ActivateAgentMessage,
  type DeliverMessageMessage,
  type SuspendAgentMessage,
  type PingMessage,
  type RuntimeReadyMessage,
  type AgentCheckinMessage,
  type AgentFrameMessage,
  type PongMessage,
} from './runtime-connection-manager.js';
