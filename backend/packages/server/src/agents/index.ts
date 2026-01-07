/**
 * @cast/server - Agent management module
 *
 * Manages agent lifecycle, spawning, and message routing.
 */

export {
  AgentManager,
  buildSystemPrompt,
  type AgentManagerConfig,
  type AgentState,
  type ManagedAgent,
  type ChannelContext,
  type RosterEntry,
} from './agent-manager.js';

export {
  createAgentInvokerAdapter,
  type AgentInvokerAdapterOptions,
  type LocalAgentRouter,
} from './invoker-adapter.js';
