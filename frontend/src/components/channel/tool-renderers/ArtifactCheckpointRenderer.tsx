/**
 * artifact_checkpoint renderer - displays version snapshot creation.
 *
 * Shows:
 * - Artifact slug
 * - Version name
 * - Optional message
 */
import { GitCommit } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

export function ArtifactCheckpointRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const normalized = normalizeArgs(args)
  const slug = (normalized.slug as string) || 'unknown'
  const version = (normalized.version as string) || ''
  const message = (normalized.message as string) || undefined

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <GitCommit className="w-4 h-4" />
        <span className="text-xs font-medium text-[#de946a]">Checkpoint created</span>
      </div>

      {/* Artifact path */}
      <div className="text-xs font-mono font-medium">
        /{slug}
      </div>

      {/* Version info */}
      <div className={cn(
        "text-xs border border-border px-3 py-2",
        !isSuccess && "opacity-60"
      )}>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Version:</span>
          <span className="font-mono font-medium text-primary">{version}</span>
        </div>
        {message && (
          <div className="mt-1 text-muted-foreground">
            {message}
          </div>
        )}
      </div>

      {/* Success confirmation */}
      {isSuccess && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ Snapshot saved
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
