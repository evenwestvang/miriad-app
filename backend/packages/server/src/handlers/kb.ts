/**
 * Knowledge Base Handlers
 *
 * REST API routes for Knowledge Base operations.
 * KBs are per-channel documentation collections that agents can query.
 *
 * Endpoints:
 * - GET  /kb                         - List all active KBs in space
 * - GET  /kb/:channel/tree           - Browse KB tree structure
 * - GET  /kb/:channel/docs/:identifier - Read KB doc by slug or path
 * - GET  /kb/:channel/search         - Search KB content (keyword FTS)
 */

import { Hono, type Context } from 'hono';
import type { Storage } from '@cast/storage';
import { requireAuth, getSpaceId } from '../auth/index.js';

// =============================================================================
// Types
// =============================================================================

export interface KBHandlerOptions {
  storage: Storage;
}

// =============================================================================
// Route Factory
// =============================================================================

export function createKBRoutes(options: KBHandlerOptions): Hono {
  const { storage } = options;
  const app = new Hono();

  // Apply auth middleware to all KB routes
  app.use('*', requireAuth);

  // ---------------------------------------------------------------------------
  // GET /kb - List all active KBs in space
  // ---------------------------------------------------------------------------
  app.get('/', async (c) => {
    const spaceId = getSpaceId(c);

    try {
      // Single JOIN query - no N+1 channel loop
      const knowledgeBases = await storage.listPublishedKnowledgeBases(spaceId);
      return c.json({ knowledgeBases });
    } catch (error) {
      console.error('[KB] Error listing knowledge bases:', error);
      return c.json({ error: 'Failed to list knowledge bases' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /kb/:channel/tree - Browse KB tree structure
  // ---------------------------------------------------------------------------
  app.get('/:channel/tree', async (c) => {
    const spaceId = getSpaceId(c);
    const channelParam = c.req.param('channel');
    const pattern = c.req.query('pattern') || '/**';

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(spaceId, channelParam);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check KB exists and is active (support legacy 'published' status)
      const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
      if (!kbRoot) {
        return c.json({ error: 'Knowledge base not found' }, 404);
      }
      if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
        return c.json({ error: 'Knowledge base is not active' }, 404);
      }

      // Get KB tree - pattern is relative to KB root, so prepend /knowledgebase
      const kbPattern = pattern.startsWith('/')
        ? `/knowledgebase${pattern}`
        : `/knowledgebase/${pattern}`;

      const fullTree = await storage.globArtifacts(channel.id, kbPattern);

      // Filter to only active docs (support legacy 'published' status) and transform to KB-relative paths
      const filterActive = (
        nodes: typeof fullTree
      ): typeof fullTree => {
        return nodes
          .filter((node) => node.status === 'active' || node.status === 'published')
          .map((node) => ({
            ...node,
            // Convert path from ltree format (knowledgebase.foo.bar) to KB-relative (/foo/bar)
            path: '/' + node.path.replace(/^knowledgebase\.?/, '').replace(/\./g, '/'),
            children: filterActive(node.children),
          }));
      };

      // The tree from glob includes the KB root - we want children only
      const kbTree = fullTree.length > 0 && fullTree[0].slug === 'knowledgebase'
        ? filterActive(fullTree[0].children)
        : filterActive(fullTree);

      return c.json({
        name: channel.name,
        pattern,
        tree: kbTree,
      });
    } catch (error) {
      console.error('[KB] Error getting KB tree:', error);
      return c.json({ error: 'Failed to get KB tree' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /kb/:channel/docs/:identifier - Read KB doc by slug or path
  // Supports both:
  // - By slug: /kb/my-channel/docs/use-effect
  // - By path: /kb/my-channel/docs/hooks/use-effect
  // ---------------------------------------------------------------------------
  app.get('/:channel/docs/*', async (c) => {
    const spaceId = getSpaceId(c);
    const channelParam = c.req.param('channel');
    // Get the full path after /docs/
    const identifier = c.req.path.split('/docs/')[1];

    if (!identifier) {
      return c.json({ error: 'Document identifier is required' }, 400);
    }

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(spaceId, channelParam);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check KB exists and is active (support legacy 'published' status)
      const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
      if (!kbRoot) {
        return c.json({ error: 'Knowledge base not found' }, 404);
      }
      if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
        return c.json({ error: 'Knowledge base is not active' }, 404);
      }

      // Try to find doc by slug first (more common case)
      let doc = await storage.getArtifact(channel.id, identifier);

      // If not found, try path lookup
      if (!doc) {
        // identifier might be a path like "hooks/use-effect"
        // Need to find by matching the path
        const artifacts = await storage.listArtifacts(channel.id, {
          search: identifier.split('/').pop(), // Search by last segment
        });

        // Find one where path ends with the identifier segments
        const pathSegments = identifier.split('/');
        const matchedSummary = artifacts.find((a) => {
          // Convert ltree path to segments
          const aPathSegments = a.path.replace(/^knowledgebase\.?/, '').split('.');
          // Check if ends with our identifier segments
          if (aPathSegments.length < pathSegments.length) return false;
          const tail = aPathSegments.slice(-pathSegments.length);
          // ltree uses underscores where slugs use hyphens
          return pathSegments.every(
            (seg, i) => seg.replace(/-/g, '_') === tail[i]
          );
        });

        // Fetch full artifact if we found a match
        if (matchedSummary) {
          doc = await storage.getArtifact(channel.id, matchedSummary.slug);
        }
      }

      if (!doc) {
        return c.json({ error: `Document not found: ${identifier}` }, 404);
      }

      // Verify it's an active doc under KB (support legacy 'published' status)
      if (doc.status !== 'active' && doc.status !== 'published') {
        return c.json({ error: `Document not found: ${identifier}` }, 404);
      }

      if (!doc.path.startsWith('knowledgebase')) {
        return c.json({ error: `Document not found: ${identifier}` }, 404);
      }

      // Convert path to KB-relative format
      const kbPath = '/' + doc.path.replace(/^knowledgebase\.?/, '').replace(/\./g, '/');

      return c.json({
        name: channel.name,
        path: kbPath || '/',
        slug: doc.slug,
        title: doc.title,
        tldr: doc.tldr,
        content: doc.content,
        parentSlug: doc.parentSlug,
        refs: doc.refs,
      });
    } catch (error) {
      console.error('[KB] Error reading KB doc:', error);
      return c.json({ error: 'Failed to read KB document' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /kb/:channel/search - Search KB content
  // Query params:
  // - q: search query (required)
  // - mode: 'keyword' (default) or 'semantic'
  // - path: limit to subtree (e.g., '/api')
  // - limit: max results (default: 10, max: 50)
  // - highlight: include snippets (default: false)
  // ---------------------------------------------------------------------------
  app.get('/:channel/search', async (c) => {
    const spaceId = getSpaceId(c);
    const channelParam = c.req.param('channel');
    const query = c.req.query('q');
    const mode = c.req.query('mode') || 'keyword';
    const pathFilter = c.req.query('path');
    const limitParam = c.req.query('limit');
    const highlight = c.req.query('highlight') === 'true';

    if (!query) {
      return c.json({ error: "Query parameter 'q' is required" }, 400);
    }

    const limit = Math.min(Math.max(parseInt(limitParam || '10', 10), 1), 50);

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(spaceId, channelParam);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check KB exists and is active (support legacy 'published' status)
      const kbRoot = await storage.getArtifact(channel.id, 'knowledgebase');
      if (!kbRoot) {
        return c.json({ error: 'Knowledge base not found' }, 404);
      }
      if (kbRoot.status !== 'active' && kbRoot.status !== 'published') {
        return c.json({ error: 'Knowledge base is not active' }, 404);
      }

      // Semantic mode not implemented yet
      if (mode === 'semantic') {
        return c.json({
          error: 'not_implemented',
          message: 'Semantic search is not yet implemented. Use mode=keyword.',
        }, 501);
      }

      // Use FTS search with KB path filter (no status filter - we'll filter for both 'active' and legacy 'published')
      // The storage.listArtifacts search uses PostgreSQL FTS
      const searchResults = await storage.listArtifacts(channel.id, {
        search: query,
        limit: limit * 3, // Fetch extra to filter by path and status
      });

      // Filter to active KB docs only (support legacy 'published' status)
      let kbResults = searchResults.filter(
        (a) => a.path.startsWith('knowledgebase') && a.type === 'doc' &&
          (a.status === 'active' || a.status === 'published')
      );

      // Apply path filter if specified
      if (pathFilter) {
        // Convert path like '/api' to ltree prefix 'knowledgebase.api'
        const ltreePrefix =
          'knowledgebase' +
          (pathFilter === '/' ? '' : '.' + pathFilter.slice(1).replace(/\//g, '.').replace(/-/g, '_'));
        kbResults = kbResults.filter((a) => a.path.startsWith(ltreePrefix));
      }

      // Limit results
      kbResults = kbResults.slice(0, limit);

      // Format results
      const results = await Promise.all(
        kbResults.map(async (a) => {
          const kbPath =
            '/' + a.path.replace(/^knowledgebase\.?/, '').replace(/\./g, '/');

          const result: {
            path: string;
            slug: string;
            title?: string;
            tldr?: string;
            score?: number;
            snippet?: string;
          } = {
            path: kbPath || '/',
            slug: a.slug,
            title: a.title,
            tldr: a.tldr,
          };

          // Get snippet if requested (requires full artifact)
          if (highlight) {
            const fullArtifact = await storage.getArtifact(channel.id, a.slug);
            if (fullArtifact?.content) {
              // Simple snippet extraction - find query terms and surrounding context
              const content = fullArtifact.content;
              const queryLower = query.toLowerCase();
              const contentLower = content.toLowerCase();
              const idx = contentLower.indexOf(queryLower);
              if (idx !== -1) {
                const start = Math.max(0, idx - 50);
                const end = Math.min(content.length, idx + query.length + 50);
                let snippet = content.slice(start, end);
                if (start > 0) snippet = '...' + snippet;
                if (end < content.length) snippet = snippet + '...';
                // Highlight the match
                const matchStart = idx - start;
                const matchEnd = matchStart + query.length;
                snippet =
                  snippet.slice(0, matchStart) +
                  '<mark>' +
                  snippet.slice(matchStart, matchEnd) +
                  '</mark>' +
                  snippet.slice(matchEnd);
                result.snippet = snippet;
              }
            }
          }

          return result;
        })
      );

      return c.json({
        name: channel.name,
        query,
        mode,
        results,
        total: results.length,
      });
    } catch (error) {
      console.error('[KB] Error searching KB:', error);
      return c.json({ error: 'Failed to search KB' }, 500);
    }
  });

  return app;
}
