/**
 * Knowledge Base Types
 *
 * Types for KB documents, search, and MCP tool interfaces.
 */

// =============================================================================
// KB Document Types
// =============================================================================

/**
 * Knowledge base metadata (from manifest artifact).
 */
export interface KBMetadata {
  /** Channel ID (KB identifier) */
  channel: string;
  /** Display title */
  title: string;
  /** KB description */
  tldr: string;
}

/**
 * A document within a knowledge base.
 */
export interface KBDocument {
  /** Document ID (artifact ID) */
  id: string;
  /** Channel this doc belongs to */
  channel: string;
  /** KB-relative path (e.g., "/hooks/use-effect") */
  path: string;
  /** Document slug */
  slug: string;
  /** Display title */
  title: string;
  /** Brief summary */
  tldr: string;
  /** Markdown content */
  content: string;
  /** Parent slug (for tree structure) */
  parentSlug?: string;
}

// =============================================================================
// Search Types
// =============================================================================

/**
 * Search mode for KB queries.
 */
export type KBSearchMode = 'keyword' | 'semantic';

/**
 * Options for KB search.
 */
export interface KBSearchOptions {
  /** Search mode: keyword (FTS5) or semantic (embeddings) */
  mode?: KBSearchMode;
  /** Limit search to subtree path */
  path?: string;
  /** Maximum results */
  limit?: number;
  /** Include highlighted snippets */
  highlight?: boolean;
}

/**
 * A single search result.
 */
export interface KBSearchResult {
  /** KB-relative path */
  path: string;
  /** Document title */
  title: string;
  /** Brief summary */
  tldr: string;
  /** Relevance score (higher = more relevant) */
  relevance: number;
  /** Optional highlighted snippet */
  snippet?: string;
}

/**
 * Full search response.
 */
export interface KBSearchResponse {
  /** KB identifier (channel) */
  kb: string;
  /** Original query */
  query: string;
  /** Search mode used */
  mode: KBSearchMode;
  /** Search results */
  results: KBSearchResult[];
  /** Total result count */
  count: number;
}

// =============================================================================
// Embedding Types
// =============================================================================

/**
 * Embedding record for semantic search.
 */
export interface KBEmbedding {
  /** Artifact ID */
  artifactId: string;
  /** Channel (KB identifier) */
  channel: string;
  /** Vector embedding (1536 dimensions for OpenAI) */
  embedding: number[];
}

/**
 * Result from embedding similarity search.
 */
export interface EmbeddingSearchResult {
  /** Artifact ID */
  artifactId: string;
  /** Channel */
  channel: string;
  /** Distance (lower = more similar) */
  distance: number;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isKBDocument(value: unknown): value is KBDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KBDocument).id === 'string' &&
    typeof (value as KBDocument).channel === 'string' &&
    typeof (value as KBDocument).path === 'string' &&
    typeof (value as KBDocument).content === 'string'
  );
}

export function isKBSearchResult(value: unknown): value is KBSearchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KBSearchResult).path === 'string' &&
    typeof (value as KBSearchResult).title === 'string' &&
    typeof (value as KBSearchResult).relevance === 'number'
  );
}
