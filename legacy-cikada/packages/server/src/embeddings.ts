/**
 * Embedding Service
 *
 * Generates embeddings using OpenAI's text-embedding-3-small model.
 * Used for semantic search in knowledge bases.
 */

import OpenAI from 'openai';

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingServiceOptions {
  /** OpenAI API key. If not provided, uses OPENAI_API_KEY env var. */
  apiKey?: string;
}

export interface EmbeddingService {
  /**
   * Generate an embedding for the given text.
   * Returns a 1536-dimensional vector.
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Check if the service is available (API key configured).
   */
  isAvailable(): boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an embedding service instance.
 * Returns null if no API key is available.
 */
export function createEmbeddingService(
  options: EmbeddingServiceOptions = {}
): EmbeddingService | null {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('[Embeddings] No OPENAI_API_KEY configured - semantic search disabled');
    return null;
  }

  const client = new OpenAI({ apiKey });

  return {
    async generateEmbedding(text: string): Promise<number[]> {
      // Truncate text if too long (max ~8k tokens for text-embedding-3-small)
      const truncatedText = text.slice(0, 30000);

      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: truncatedText,
        dimensions: 1536,
      });

      return response.data[0].embedding;
    },

    isAvailable(): boolean {
      return true;
    },
  };
}

/**
 * Build searchable text from a KB document.
 * Combines title, summary, and content for embedding.
 */
export function buildEmbeddingText(doc: {
  title: string;
  tldr: string;
  content: string;
}): string {
  return `${doc.title}\n\n${doc.tldr}\n\n${doc.content}`;
}

// =============================================================================
// KB Indexer
// =============================================================================

export interface KBIndexerOptions {
  embeddingService: EmbeddingService;
  storage: {
    storeEmbedding(spaceId: string, artifactId: string, channel: string, embedding: number[]): Promise<void>;
    deleteEmbedding(spaceId: string, artifactId: string): Promise<boolean>;
    hasEmbedding(spaceId: string, artifactId: string): Promise<boolean>;
  };
  /** Space ID for multi-tenancy (Phase 1: hardcoded 'default') */
  spaceId: string;
}

export interface KBIndexer {
  /**
   * Index a KB document for semantic search.
   */
  indexDocument(doc: {
    id: string;
    channel: string;
    title: string;
    tldr: string;
    content: string;
  }): Promise<void>;

  /**
   * Remove a document from the semantic search index.
   */
  removeDocument(artifactId: string): Promise<void>;

  /**
   * Check if a document is indexed.
   */
  isIndexed(artifactId: string): Promise<boolean>;
}

/**
 * Create a KB indexer for managing document embeddings.
 */
export function createKBIndexer(options: KBIndexerOptions): KBIndexer {
  const { embeddingService, storage, spaceId } = options;

  return {
    async indexDocument(doc): Promise<void> {
      const text = buildEmbeddingText(doc);
      const embedding = await embeddingService.generateEmbedding(text);
      await storage.storeEmbedding(spaceId, doc.id, doc.channel, embedding);
      console.log(`[KBIndexer] Indexed document: ${doc.id} (${doc.channel})`);
    },

    async removeDocument(artifactId: string): Promise<void> {
      const deleted = await storage.deleteEmbedding(spaceId, artifactId);
      if (deleted) {
        console.log(`[KBIndexer] Removed document from index: ${artifactId}`);
      }
    },

    async isIndexed(artifactId: string): Promise<boolean> {
      return storage.hasEmbedding(spaceId, artifactId);
    },
  };
}
