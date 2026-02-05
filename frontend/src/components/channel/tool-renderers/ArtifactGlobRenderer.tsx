/**
 * artifact_glob renderer - displays artifact tree view results.
 *
 * Shows:
 * - Glob pattern used
 * - Tree structure of matching artifacts
 */
import { FolderTree } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

export function ArtifactGlobRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const normalized = normalizeArgs(args)
  const pattern = (normalized.pattern as string) || '/**'
  const channel = (normalized.channel as string) || undefined

  // Output is typically a tree string
  let treeOutput = ''
  if (typeof output === 'string') {
    treeOutput = output
  } else if (output && typeof output === 'object' && 'text' in output) {
    treeOutput = (output as { text: string }).text
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <FolderTree className="w-4 h-4" />
        <span className="text-xs font-medium text-[#de946a]">Artifact tree</span>
      </div>

      {/* Pattern */}
      <div className="text-xs">
        <span className="text-muted-foreground">Pattern: </span>
        <span className="font-mono font-medium">{pattern}</span>
        {channel && (
          <>
            <span className="text-muted-foreground ml-2">in </span>
            <span className="font-mono">{channel}</span>
          </>
        )}
      </div>

      {/* Tree output */}
      {treeOutput && (
        <div className={cn(
          "text-xs font-mono bg-muted/50 p-3 border border-border max-h-64 overflow-y-auto whitespace-pre",
          !isSuccess && "opacity-60"
        )}>
          {treeOutput}
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
