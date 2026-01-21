/**
 * WebSearch renderer - displays search results from the web.
 *
 * Shows:
 * - Search query
 * - Result count
 * - Result list with title (as clickable link), domain, snippet
 * - Sources list at bottom (required by tool contract)
 */
import { Search, ExternalLink } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

const MAX_RESULTS_PREVIEW = 5

interface SearchResult {
  title: string
  url: string
  snippet?: string
  domain?: string
}

/**
 * Parse search results from output.
 */
function parseSearchResults(output: unknown): SearchResult[] {
  if (Array.isArray(output)) {
    return output.map(result => ({
      title: result.title || 'Untitled',
      url: result.url || result.link || '',
      snippet: result.snippet || result.description,
      domain: result.domain || new URL(result.url || result.link || 'https://example.com').hostname,
    }))
  }
  if (output && typeof output === 'object' && 'results' in output) {
    const results = (output as { results: unknown }).results
    if (Array.isArray(results)) {
      return results.map(result => ({
        title: result.title || 'Untitled',
        url: result.url || result.link || '',
        snippet: result.snippet || result.description,
        domain: result.domain || new URL(result.url || result.link || 'https://example.com').hostname,
      }))
    }
  }
  return []
}

export function WebSearchRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const query = (args.query as string) || ''

  const results = parseSearchResults(output)
  const totalCount = results.length
  const displayResults = results.slice(0, MAX_RESULTS_PREVIEW)

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4" />
        <span className="text-xs font-medium text-primary">WebSearch</span>
      </div>

      {/* Query */}
      <div className="text-xs">
        <span className="text-muted-foreground">Query:</span>{' '}
        <span className="font-medium">"{query}"</span>
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground">
        {totalCount === 0 ? (
          <span>No results found</span>
        ) : (
          <span className="text-green-600 dark:text-green-400 font-medium">
            Found {totalCount} {totalCount === 1 ? 'result' : 'results'}
          </span>
        )}
      </div>

      {/* Results list */}
      {totalCount > 0 && (
        <div className={cn(
          "space-y-3",
          !isSuccess && "opacity-60"
        )}>
          {displayResults.map((result, index) => (
            <div key={index} className="space-y-1">
              {/* Title as clickable link */}
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base font-medium text-primary hover:underline flex items-center gap-1"
              >
                {result.title}
                <ExternalLink className="w-3 h-3" />
              </a>
              {/* Domain */}
              {result.domain && (
                <div className="text-xs text-muted-foreground">
                  {result.domain}
                </div>
              )}
              {/* Snippet */}
              {result.snippet && (
                <div className="text-xs text-muted-foreground">
                  {result.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sources section (required by tool contract) */}
      {totalCount > 0 && (
        <div className="text-xs text-muted-foreground border-t border-border pt-2 mt-3">
          <div className="font-medium mb-1">Sources:</div>
          <ul className="space-y-0.5">
            {results.map((result, index) => (
              <li key={index}>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {result.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Error message if failed */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2">
          {error}
        </div>
      )}
    </div>
  )
}
