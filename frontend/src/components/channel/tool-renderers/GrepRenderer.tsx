/**
 * Grep tool renderer - displays search operations and results.
 *
 * Shows:
 * - Search pattern
 * - Path and include filter
 * - Match results with file:line format
 */
import { useIsDarkMode } from '../../../hooks/useIsDarkMode'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

/**
 * Parse grep output into structured matches.
 */
function parseGrepOutput(output: unknown): string[] {
  if (typeof output === 'string') {
    return output.split('\n').filter(line => line.trim())
  }
  if (Array.isArray(output)) {
    return output.map(String)
  }
  return []
}

export function GrepRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const isDarkMode = useIsDarkMode()
  const normalized = normalizeArgs(args)

  const pattern = (normalized.pattern as string) || ''
  const path = (normalized.path as string) || '.'
  const include = (normalized.include as string) || ''

  const matches = parseGrepOutput(output)
  const matchCount = matches.length

  return (
    <div className="space-y-2">
      {/* Search info */}
      <div className="text-xs space-y-1">
        <div>
          <span className="text-muted-foreground">Pattern: </span>
          <span className="font-mono text-amber-600 dark:text-amber-400">{pattern}</span>
        </div>
        <div className="text-muted-foreground">
          <span>Path: </span>
          <span className="font-mono">{path}</span>
          {include && (
            <>
              <span className="mx-2">•</span>
              <span>Include: </span>
              <span className="font-mono">{include}</span>
            </>
          )}
        </div>
      </div>

      {/* Results */}
      {isSuccess && matchCount > 0 && (
        <div className={cn(
          "text-xs font-mono rounded overflow-hidden max-h-64 overflow-y-auto",
          isDarkMode ? "bg-[#282c34]" : "bg-[#fafafa]"
        )}>
          <div className={cn(
            "px-3 py-1.5 border-b text-muted-foreground",
            isDarkMode ? "border-[#181a1f]" : "border-[#e0e0e0]"
          )}>
            {matchCount} {matchCount === 1 ? 'match' : 'matches'}
          </div>
          <div className="p-2 space-y-0.5">
            {matches.slice(0, 50).map((match, i) => (
              <div key={i} className={cn(
                "px-1 py-0.5 rounded",
                isDarkMode ? "text-[#abb2bf]" : "text-[#383a42]"
              )}>
                {match}
              </div>
            ))}
            {matchCount > 50 && (
              <div className="text-muted-foreground px-1 py-1">
                ... and {matchCount - 50} more matches
              </div>
            )}
          </div>
        </div>
      )}

      {/* No matches */}
      {isSuccess && matchCount === 0 && (
        <div className="text-xs text-muted-foreground">
          No matches found
        </div>
      )}

      {/* Error */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}
    </div>
  )
}
