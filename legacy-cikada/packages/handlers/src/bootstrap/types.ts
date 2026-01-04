/**
 * Bootstrap Types
 *
 * Type definitions for space bootstrapping and seeding.
 */

/**
 * Input for creating an artifact during seeding.
 */
export interface SeedArtifactInput {
  slug: string;
  type: string;
  title: string;
  tldr: string;
  content: string;
  status: string;
  props?: Record<string, unknown>;
}

/**
 * Input for creating a channel during bootstrap/seeding.
 */
export interface BootstrapChannelInput {
  id: string;
  name: string;
  description?: string;
  tagline?: string;
  mission?: string;
}

/**
 * Minimal channel data returned from storage.
 */
export interface ChannelData {
  id: string;
  name: string;
}

/**
 * Result of seeding a space.
 */
export interface SeedResult {
  rootChannelId: string;
  created: string[];
  skipped: string[];
}

/**
 * Storage adapter interface for bootstrap operations.
 * Abstracts away SQLite vs DynamoDB differences.
 */
export interface BootstrapStorage {
  /**
   * Get a channel by name within a space.
   */
  getChannelByName(spaceId: string, name: string): Promise<ChannelData | null>;

  /**
   * Create a new channel.
   */
  createChannel(spaceId: string, input: BootstrapChannelInput): Promise<ChannelData>;

  /**
   * Get an artifact by slug.
   */
  getArtifact(spaceId: string, channelId: string, slug: string): Promise<{ slug: string } | null>;

  /**
   * Create a new artifact.
   */
  createArtifact(
    spaceId: string,
    channelId: string,
    input: SeedArtifactInput & { createdBy: string }
  ): Promise<void>;

  /**
   * Get a space by ID.
   */
  getSpace(spaceId: string): Promise<{ id: string } | null>;

  /**
   * Create a new space.
   */
  createSpace(input: { id: string; ownerId: string; name: string }): Promise<void>;
}
