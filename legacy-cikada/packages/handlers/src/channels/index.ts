/**
 * Channel Handlers Module
 *
 * Exports functions for channel operations including creation, roster management,
 * and querying. Platform-agnostic - works with any storage backend.
 */

export type {
  Channel,
  CreateChannelInput,
  AddAgentInput,
  RosterEntry,
  AgentConfig,
  AgentEngine,
  FocusProps,
  ResolvedFocus,
  Message,
  SaveMessageInput,
  ChannelStorage,
  ChannelHandlerContext,
} from './types.js';

export {
  resolveFocusArea,
  createChannel,
  getChannel,
  listChannels,
  archiveChannel,
  addAgentToChannel,
  removeAgentFromChannel,
  type CreateChannelOptions,
  type CreateChannelResult,
  type AddAgentOptions,
  type AddAgentResult,
} from './handlers.js';
