/**
 * Embedding Service for Knowledge Base Semantic Search
 *
 * Generates embeddings using OpenAI's text-embedding-3-small model (1536 dimensions)
 * and hooks into artifact lifecycle events for KB docs.
 */

import { store, Artifact } from "./store.js";

// OpenAI embedding model configuration
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

// Track initialization state
let initialized = false;
let apiKey: string | null = null;

/**
 * Check if embeddings are enabled (API key is configured)
 */
export function isEmbeddingsEnabled(): boolean {
  return apiKey !== null;
}

/**
 * Get embedding dimensions (for reference)
 */
export function getEmbeddingDimensions(): number {
  return EMBEDDING_DIMENSIONS;
}

/**
 * Generate embedding for text using OpenAI API
 * Returns null if API key is not configured or on error
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[embeddings] OpenAI API error: ${response.status} ${error}`);
      return null;
    }

    const data = await response.json();
    return data.data[0].embedding as number[];
  } catch (err) {
    console.error("[embeddings] Failed to generate embedding:", err);
    return null;
  }
}

/**
 * Build embedding text from artifact fields
 * Combines title, tldr, and content for comprehensive semantic representation
 */
function buildEmbeddingText(artifact: Artifact): string {
  const parts: string[] = [];
  if (artifact.title) parts.push(artifact.title);
  if (artifact.tldr) parts.push(artifact.tldr);
  if (artifact.content) parts.push(artifact.content);
  return parts.join(" ");
}

/**
 * Check if artifact is a KB doc that should be embedded
 */
function isKBDoc(artifact: Artifact): boolean {
  // Must be a doc type
  if (artifact.type !== "doc") return false;

  // Must be under /knowledgebase path (child of knowledgebase artifact)
  if (!artifact.path.includes("/knowledgebase/")) return false;

  // Must be published
  if (artifact.status !== "published") return false;

  return true;
}

/**
 * Process artifact event - generate/update/delete embedding as needed
 */
async function handleArtifactEvent(event: { action: string; artifact: Artifact }): Promise<void> {
  const { action, artifact } = event;

  // Only process KB docs for create/update
  if (action === "created" || action === "updated") {
    if (!isKBDoc(artifact)) return;

    const text = buildEmbeddingText(artifact);
    const embedding = await generateEmbedding(text);
    if (embedding) {
      store.storeEmbedding(artifact.id, artifact.channel, embedding);
      console.log(`[embeddings] ${action === "created" ? "Created" : "Updated"} embedding for ${artifact.path}`);
    }
  } else if (action === "deleted") {
    // Always try to remove embedding on delete
    const removed = store.deleteEmbedding(artifact.id);
    if (removed) {
      console.log(`[embeddings] Removed embedding for ${artifact.path}`);
    }
  }
}

/**
 * Subscribe to artifact events for all KB channels
 */
function subscribeToKBChannels(): void {
  // Get all channels that have a knowledgebase artifact
  const kbs = store.listPublishedKnowledgeBases();

  for (const kb of kbs) {
    store.subscribeToArtifactEvents(kb.channel, (event) => {
      // Handle async without blocking
      handleArtifactEvent(event).catch((err) => {
        console.error(`[embeddings] Error handling event:`, err);
      });
    });
    console.log(`[embeddings] Subscribed to artifact events for channel: ${kb.channel}`);
  }
}

/**
 * Initialize the embedding service
 * Call this at server startup after store is initialized
 */
export function initEmbeddings(): void {
  if (initialized) return;

  // Check for OpenAI API key
  apiKey = process.env.OPENAI_API_KEY || null;

  if (!apiKey) {
    console.log("[embeddings] OPENAI_API_KEY not configured - semantic search disabled");
    initialized = true;
    return;
  }

  console.log(`[embeddings] Initialized with model ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS} dims)`);

  // Subscribe to artifact events for existing KB channels
  subscribeToKBChannels();

  initialized = true;
}

/**
 * Re-index all KB docs (for backfill or recovery)
 * This is an expensive operation - use sparingly
 */
export async function reindexAllKBDocs(): Promise<{ indexed: number; failed: number }> {
  if (!apiKey) {
    return { indexed: 0, failed: 0 };
  }

  const kbs = store.listPublishedKnowledgeBases();
  let indexed = 0;
  let failed = 0;

  for (const kb of kbs) {
    const docs = store.getKBContent(kb.channel);

    for (const doc of docs) {
      if (!isKBDoc(doc)) continue;

      const text = buildEmbeddingText(doc);
      const embedding = await generateEmbedding(text);

      if (embedding) {
        store.storeEmbedding(doc.id, doc.channel, embedding);
        indexed++;
      } else {
        failed++;
      }

      // Rate limit to avoid hitting OpenAI limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(`[embeddings] Reindex complete: ${indexed} indexed, ${failed} failed`);
  return { indexed, failed };
}
