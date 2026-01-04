/**
 * Knowledge Base MCP Tools
 *
 * Implements KB-specific tools for agent access to knowledge bases:
 * - kb_list: List all published KBs
 * - kb_glob: Browse KB tree structure
 * - kb_read: Read a doc by path
 * - kb_query: Search KB content (keyword/semantic modes)
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { store, Artifact } from "./store.js";
import { generateEmbedding, isEmbeddingsEnabled } from "./embeddings.js";
import { matchGlob } from "./artifact-tools.js";

// Helper: Build tree view for KB content with glob pattern support
function buildKBTreeView(artifacts: Artifact[], pattern: string = "/**"): string {
  // Filter by glob pattern (applied to KB-relative paths)
  const filtered = artifacts.filter(a => {
    const relativePath = a.path.replace(/^\/knowledgebase/, "") || "/";
    return matchGlob(relativePath, pattern);
  });

  if (filtered.length === 0) return "(no matches)";

  // Build tree structure
  interface TreeNode {
    name: string;
    title?: string;
    children: Map<string, TreeNode>;
  }

  const root: TreeNode = { name: "", children: new Map() };

  for (const artifact of filtered) {
    // Get path relative to /knowledgebase
    const relativePath = artifact.path.replace(/^\/knowledgebase\/?/, "");
    if (!relativePath) continue;

    const parts = relativePath.split("/").filter(p => p);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
      // Mark title on leaf nodes
      if (i === parts.length - 1) {
        current.title = artifact.title || artifact.tldr?.slice(0, 50);
      }
    }
  }

  // Render tree as indented string
  function render(node: TreeNode, indent: number): string[] {
    const lines: string[] = [];
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      // Directories (nodes with children) first
      const aHasChildren = a.children.size > 0;
      const bHasChildren = b.children.size > 0;
      if (aHasChildren && !bHasChildren) return -1;
      if (!aHasChildren && bHasChildren) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of sortedChildren) {
      const prefix = "  ".repeat(indent);
      const titleSuffix = child.title ? ` - ${child.title}` : "";
      lines.push(`${prefix}${child.name}${titleSuffix}`);
      lines.push(...render(child, indent + 1));
    }

    return lines;
  }

  return render(root, 0).join("\n");
}

/**
 * Register all KB MCP tools on the server
 */
export function registerKBTools(server: McpServer): void {
  // Tool: kb_list
  server.tool(
    "kb_list",
    `List all published knowledge bases.

Returns all KBs with status=published across all channels.
Use kb_glob or kb_read to browse/read specific KB content.`,
    {},
    async () => {
      const kbs = store.listPublishedKnowledgeBases();

      return {
        content: [{
          type: "text",
          text: JSON.stringify(kbs.map(kb => ({
            kb: kb.channel,
            title: kb.title,
            tldr: kb.tldr,
          })), null, 2),
        }],
      };
    }
  );

  // Tool: kb_glob
  server.tool(
    "kb_glob",
    `Get a tree view of KB documents matching a glob pattern.

Patterns:
- "/**" — entire KB tree (default)
- "/hooks/**" — subtree under hooks
- "/**/*-guide" — all docs ending in -guide
- "/*" — root level only

Format: Indentation shows hierarchy. Titles shown as suffix.`,
    {
      kb: z.string().describe("Knowledge base identifier (channel name)"),
      pattern: z.string().optional().describe("Glob pattern (default: /**)"),
    },
    async ({ kb, pattern }) => {
      const kbArtifact = store.getKnowledgeBase(kb);
      if (!kbArtifact) {
        return {
          isError: true,
          content: [{ type: "text", text: `Knowledge base not found: ${kb}` }],
        };
      }

      // Get all KB content and filter by pattern
      const content = store.getKBContent(kb);
      const tree = buildKBTreeView(content, pattern || "/**");

      return {
        content: [{ type: "text", text: tree }],
      };
    }
  );

  // Tool: kb_read
  server.tool(
    "kb_read",
    `Read a specific document from a KB by path.

Path is relative to the KB root (e.g., "/hooks/use-effect" or "hooks/use-effect").`,
    {
      kb: z.string().describe("Knowledge base identifier (channel name)"),
      path: z.string().describe("Path relative to KB root (e.g., '/hooks/use-effect')"),
    },
    async ({ kb, path }) => {
      const kbArtifact = store.getKnowledgeBase(kb);
      if (!kbArtifact) {
        return {
          isError: true,
          content: [{ type: "text", text: `Knowledge base not found: ${kb}` }],
        };
      }

      const doc = store.getKBDoc(kb, path);
      if (!doc) {
        return {
          isError: true,
          content: [{ type: "text", text: `Document not found: ${path} in KB '${kb}'` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            path: doc.path.replace(/^\/knowledgebase/, ""),
            title: doc.title,
            tldr: doc.tldr,
            content: doc.content,
          }, null, 2),
        }],
      };
    }
  );

  // Tool: kb_query - Full-text search using FTS5 with BM25 ranking
  server.tool(
    "kb_query",
    `Search a knowledge base using full-text search.

Modes:
- keyword: Full-text search using FTS5 (BM25 ranking, stemming, phrase search)
- semantic: Vector similarity search (requires embeddings - Phase 2)

FTS5 query syntax supports:
- Simple words: "authentication api"
- Phrases: '"exact phrase"'
- Prefix: "auth*"
- Boolean: "auth AND api", "auth OR login", "auth NOT basic"

Returns matching documents ranked by relevance.`,
    {
      kb: z.string().describe("Knowledge base identifier (channel name)"),
      query: z.string().describe("Search query (supports FTS5 syntax: phrases, prefix, boolean)"),
      mode: z.enum(["keyword", "semantic"]).default("keyword").describe("Search mode"),
      path: z.string().optional().describe("Optional - limit search to subtree"),
      limit: z.number().optional().default(5).describe("Max results (default: 5)"),
      highlight: z.boolean().optional().default(false).describe("Include highlighted snippets"),
    },
    async ({ kb, query, mode, path, limit, highlight }) => {
      const kbArtifact = store.getKnowledgeBase(kb);
      if (!kbArtifact) {
        return {
          isError: true,
          content: [{ type: "text", text: `Knowledge base not found: ${kb}` }],
        };
      }

      if (mode === "semantic") {
        // Check if embeddings are enabled
        if (!isEmbeddingsEnabled()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Semantic search unavailable: OPENAI_API_KEY not configured" }],
          };
        }

        // Generate embedding for the query
        const queryEmbedding = await generateEmbedding(query);
        if (!queryEmbedding) {
          return {
            isError: true,
            content: [{ type: "text", text: "Failed to generate embedding for query" }],
          };
        }

        // Search by vector similarity
        const vectorResults = store.searchByEmbedding(queryEmbedding, {
          channel: kb,
          limit: (limit || 5) * 2,  // Get extra to filter by path
        });

        // Get full artifacts and filter by path if specified
        const matches: Array<{
          path: string;
          title?: string;
          tldr?: string;
          similarity: number;
        }> = [];

        for (const result of vectorResults) {
          const artifact = store.getArtifactById(result.artifactId);
          if (!artifact) continue;

          // Filter to KB docs only
          if (!artifact.path.startsWith("/knowledgebase")) continue;

          // Filter by path if specified
          if (path) {
            const normalizedPath = path.startsWith("/") ? path : `/${path}`;
            const kbPathPrefix = `/knowledgebase${normalizedPath}`;
            if (!artifact.path.startsWith(kbPathPrefix)) continue;
          }

          matches.push({
            path: artifact.path.replace(/^\/knowledgebase/, ""),
            title: artifact.title,
            tldr: artifact.tldr,
            similarity: 1 - result.distance,  // Convert distance to similarity (0-1)
          });

          if (matches.length >= (limit || 5)) break;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              kb,
              query,
              mode,
              results: matches,
              count: matches.length,
            }, null, 2),
          }],
        };
      }

      // Use FTS5 full-text search with BM25 ranking
      const searchResults = store.searchArtifactsFTS(query, {
        channel: kb,
        type: "doc",  // Only search doc artifacts within KB
        status: "published",
        limit: limit || 5,
        highlight: highlight || false,
      });

      // Filter results to KB subtree if path specified
      let filteredResults = searchResults;
      if (path) {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const kbPathPrefix = `/knowledgebase${normalizedPath}`;
        filteredResults = searchResults.filter(doc => doc.path.startsWith(kbPathPrefix));
      } else {
        // Only include docs under /knowledgebase path
        filteredResults = searchResults.filter(doc => doc.path.startsWith("/knowledgebase"));
      }

      const matches = filteredResults.map(doc => ({
        path: doc.path.replace(/^\/knowledgebase/, ""),
        title: doc.title,
        tldr: doc.tldr,
        relevance: Math.abs(doc.rank),  // BM25 scores are negative, lower = more relevant
        ...(doc.snippet ? { snippet: doc.snippet } : {}),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kb,
            query,
            mode,
            results: matches,
            count: matches.length,
          }, null, 2),
        }],
      };
    }
  );
}
