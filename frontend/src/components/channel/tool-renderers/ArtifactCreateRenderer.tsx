/**
 * artifact_create renderer - displays artifact creation on the board.
 *
 * Shows:
 * - Artifact path with tree structure
 * - Artifact type badge
 * - TLDR summary
 * - Content preview
 * - Link to view on board (future enhancement)
 */
import { FileText, ListTodo, FileCode, GitBranch } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

const MAX_CONTENT_PREVIEW = 3 // Show first 3 lines of content

/**
 * Get icon for artifact type.
 */
function getArtifactIcon(type: string) {
  switch (type) {
    case 'doc':
      return <FileText className="w-4 h-4" />
    case 'task':
      return <ListTodo className="w-4 h-4" />
    case 'code':
      return <FileCode className="w-4 h-4" />
    case 'decision':
      return <GitBranch className="w-4 h-4" />
    default:
      return <FileText className="w-4 h-4" />
  }
}

/**
 * Get color for artifact type badge.
 */
function getTypeBadgeColor(type: string): string {
  switch (type) {
    case 'task':
      return 'bg-blue-500'
    case 'decision':
      return 'bg-purple-500'
    case 'code':
      return 'bg-green-500'
    default:
      return 'bg-[#de946a]' // Cast orange for docs
  }
}

export function ArtifactCreateRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const slug = (args.slug as string) || 'unknown'
  const type = (args.type as string) || 'doc'
  const title = (args.title as string) || undefined
  const tldr = (args.tldr as string) || undefined
  const content = (args.content as string) || ''
  const parentSlug = (args.parentSlug as string) || undefined

  // Preview first few lines of content
  const contentLines = content.split('\n').filter(line => line.trim())
  const contentPreview = contentLines.slice(0, MAX_CONTENT_PREVIEW).join('\n')
  const hasMoreContent = contentLines.length > MAX_CONTENT_PREVIEW

  return (
    <div className="space-y-2">
      {/* Header with type badge and path */}
      <div className="flex items-center gap-2">
        {getArtifactIcon(type)}
        <span className="text-xs font-medium text-[#de946a]">Created artifact</span>
        <span className={cn(
          "px-2 py-0.5 text-[10px] font-semibold text-white uppercase tracking-wide",
          getTypeBadgeColor(type)
        )}>
          {type}
        </span>
      </div>

      {/* Artifact path */}
      <div className="flex items-center gap-2">
        {parentSlug && (
          <span className="text-xs font-mono text-muted-foreground">
            {parentSlug} /
          </span>
        )}
        <span className="text-xs font-mono font-medium">/{slug}</span>
      </div>

      {/* Title if provided */}
      {title && (
        <div className="text-base font-medium text-foreground">
          {title}
        </div>
      )}

      {/* TLDR summary */}
      {tldr && (
        <div className="text-xs text-muted-foreground">
          {tldr}
        </div>
      )}

      {/* Content preview */}
      {content && (
        <div className={cn(
          "text-xs font-mono bg-muted/50 p-2 border border-border overflow-hidden",
          !isSuccess && "opacity-60"
        )}>
          <pre className="whitespace-pre-wrap text-muted-foreground">
            {contentPreview}
          </pre>
          {hasMoreContent && (
            <div className="text-muted-foreground/60 mt-1">
              ... and {contentLines.length - MAX_CONTENT_PREVIEW} more lines
            </div>
          )}
        </div>
      )}

      {/* Success confirmation */}
      {isSuccess && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ Artifact created successfully
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
