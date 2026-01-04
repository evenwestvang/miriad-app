/**
 * Bootstrap Module
 *
 * Exports functions for bootstrapping and seeding spaces with default content.
 * Platform-agnostic - works with any storage backend that implements BootstrapStorage.
 */

export type {
  SeedArtifactInput,
  BootstrapChannelInput,
  ChannelData,
  SeedResult,
  BootstrapStorage,
} from './types.js';

export {
  getDefaultArtifacts,
  ROOT_CHANNEL_CONFIG,
} from './seed-data.js';

export {
  seedSpace,
  bootstrap,
  getRootChannelId,
  ROOT_CHANNEL_NAME,
} from './seed.js';
