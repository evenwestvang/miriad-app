/**
 * artifact_list renderer - displays artifact search/query results.
 *
 * Shows:
 * - Query parameters (filters used)
 * - Result count
 * - Artifact list with path, type, tldr, and status
 */
import { FileText, ListTodo, FileCode, GitBranch } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

const MAX_RESULTS_PREVIEW = 20

/**
 * Get icon for artifact type.
 */
function getArtifactIcon(type: string) {
  switch (type) {
    case 'doc':
      return <FileText className="w-3 h-3" />
    case 'task':
      return <ListTodo className="w-3 h-3" />
    case 'code':
      return <FileCode className="w-3 h-3" />
    case 'decision':
      return <GitBranch className="w-3 h-3" />
    default:
      return <FileText className="w-3 h-3" />
  }
}

/**
 * Parse artifact list from output.
 */
function parseArtifactList(output: unknown): Array<{
  slug: string
  type: string
  tldr?: string
  status?: string
}> {
  if (Array.isArray(output)) {
    return output.map(item => ({
      slug: item.slug || 'unknown',
      type: item.type || 'doc',
      tldr: item.tldr,
      status: item.status,
    }))
  }
  if (output && typeof output === 'object' && 'artifacts' in output) {
    const artifacts = (output as { artifacts: unknown }).artifacts
    if (Array.isArray(artifacts)) {
      return artifacts.map(item => ({
        slug: item.slug || 'unknown',
        type: item.type || 'doc',
        tldr: item.tldr,
        status: item.status,
      }))
    }
  }
  return []
}

export function ArtifactListRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const type = (args.type as string) || undefined
  const status = (args.status as string) || undefined
  const search = (args.search as string) || undefined
  const parentSlug = (args.parentSlug as string) || undefined

  const artifacts = parseArtifactList(output)
  const totalCount = artifacts.length
  const displayArtifacts = artifacts.slice(0, MAX_RESULTS_PREVIEW)
  const hasMore = totalCount > MAX_RESULTS_PREVIEW

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4" />
        <span className="text-xs font-medium text-[#de946a]">Listed artifacts</span>
      </div>

      {/* Query filters */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        {type && (
          <span className="px-2 py-0.5 bg-muted border border-border">
            type: {type}
          </span>
        )}
        {status && (
          <span className="px-2 py-0.5 bg-muted border border-border">
            status: {status}
          </span>
        )}
        {search && (
          <span className="px-2 py-0.5 bg-muted border border-border">
            search: "{search}"
          </span>
        )}
        {parentSlug && (
          <span className="px-2 py-0.5 bg-muted border border-border">
            parent: {parentSlug}
          </span>
        )}
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground">
        {totalCount === 0 ? (
          <span>No artifacts found</span>
        ) : (
          <span className="text-green-600 dark:text-green-400 font-medium">
            Found {totalCount} {totalCount === 1 ? 'artifact' : 'artifacts'}
          </span>
        )}
      </div>

      {/* Artifact list */}
      {totalCount > 0 && (
        <div className={cn(
          "border border-border overflow-hidden",
          !isSuccess && "opacity-60"
        )}>
          <div className="max-h-64 overflow-y-auto">
            {displayArtifacts.map((artifact, index) => (
              <div
                key={index}
                className={cn(
                  "flex items-start gap-2 px-3 py-2 hover:bg-muted/50",
                  index !== displayArtifacts.length - 1 && "border-b border-border"
                )}
              >
                <span className="flex-shrink-0 mt-0.5 text-muted-foreground">
                  {getArtifactIcon(artifact.type)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium truncate">
                      /{artifact.slug}
                    </span>
                    {artifact.status && (
                      <span className="text-xs text-muted-foreground capitalize">
                        {artifact.status}
                      </span>
                    )}
                  </div>
                  {artifact.tldr && (
                    <div className="text-xs text-muted-foreground truncate">
                      {artifact.tldr}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {hasMore && (
              <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/30 border-t border-border">
                ... and {totalCount - MAX_RESULTS_PREVIEW} more artifacts
              </div>
            )}
          </div>
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
