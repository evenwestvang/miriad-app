/**
 * artifact_read renderer - displays artifact retrieval from the board.
 *
 * Shows:
 * - Artifact path
 * - Type and metadata
 * - TLDR summary
 * - Content with formatting
 * - Version info if available
 */
import { FileText, ListTodo, FileCode, GitBranch } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

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
 * Parse artifact data from output.
 */
function parseArtifactData(output: unknown): {
  slug: string
  type: string
  title?: string
  tldr?: string
  content?: string
  version?: number
  status?: string
} {
  if (output && typeof output === 'object') {
    return {
      slug: 'slug' in output ? String(output.slug) : 'unknown',
      type: 'type' in output ? String(output.type) : 'doc',
      title: 'title' in output ? String(output.title) : undefined,
      tldr: 'tldr' in output ? String(output.tldr) : undefined,
      content: 'content' in output ? String(output.content) : undefined,
      version: 'version' in output ? Number(output.version) : undefined,
      status: 'status' in output ? String(output.status) : undefined,
    }
  }
  return { slug: 'unknown', type: 'doc' }
}

export function ArtifactReadRenderer({ output, error, isSuccess }: ToolRendererProps) {
  const artifact = parseArtifactData(output)

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        {getArtifactIcon(artifact.type)}
        <span className="text-xs font-medium text-[#de946a]">Read artifact</span>
      </div>

      {/* Artifact path */}
      <div className="text-xs font-mono font-medium">
        /{artifact.slug}
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="uppercase tracking-wide">{artifact.type}</span>
        {artifact.version && (
          <span>v{artifact.version}</span>
        )}
        {artifact.status && (
          <span className="capitalize">{artifact.status}</span>
        )}
      </div>

      {/* Title if provided */}
      {artifact.title && (
        <div className="text-base font-medium text-foreground">
          {artifact.title}
        </div>
      )}

      {/* TLDR summary */}
      {artifact.tldr && (
        <div className="text-xs text-muted-foreground">
          {artifact.tldr}
        </div>
      )}

      {/* Content (truncated) */}
      {artifact.content && (
        <div className={cn(
          "text-xs font-mono bg-muted/50 p-2 border border-border max-h-48 overflow-y-auto",
          !isSuccess && "opacity-60"
        )}>
          <pre className="whitespace-pre-wrap text-muted-foreground">
            {artifact.content.slice(0, 500)}
            {artifact.content.length > 500 && '\n...'}
          </pre>
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
