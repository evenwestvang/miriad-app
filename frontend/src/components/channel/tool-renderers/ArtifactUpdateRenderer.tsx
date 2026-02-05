/**
 * artifact_update renderer - displays artifact metadata updates.
 *
 * Shows:
 * - Artifact slug
 * - Fields changed with old → new values
 */
import { RefreshCw } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

interface FieldChange {
  field: string
  oldValue: unknown
  newValue: unknown
}

export function ArtifactUpdateRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const normalized = normalizeArgs(args)
  const slug = (normalized.slug as string) || 'unknown'
  const changes = (normalized.changes as FieldChange[]) || []

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <RefreshCw className="w-4 h-4" />
        <span className="text-xs font-medium text-[#de946a]">Updated artifact</span>
      </div>

      {/* Artifact path */}
      <div className="text-xs font-mono font-medium">
        /{slug}
      </div>

      {/* Changes */}
      {changes.length > 0 && (
        <div className={cn(
          "text-xs font-mono border border-border overflow-hidden",
          !isSuccess && "opacity-60"
        )}>
          {changes.map((change, index) => (
            <div
              key={index}
              className={cn(
                "px-3 py-1.5",
                index !== changes.length - 1 && "border-b border-border"
              )}
            >
              <span className="text-muted-foreground">{change.field}: </span>
              <span className="text-red-600 dark:text-red-400 line-through">
                {JSON.stringify(change.oldValue)}
              </span>
              <span className="text-muted-foreground mx-1">→</span>
              <span className="text-green-600 dark:text-green-400">
                {JSON.stringify(change.newValue)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Summary if no detailed changes */}
      {changes.length === 0 && isSuccess && (
        <div className="text-xs text-muted-foreground">
          Metadata updated
        </div>
      )}

      {/* Success confirmation */}
      {isSuccess && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ {changes.length} {changes.length === 1 ? 'field' : 'fields'} updated
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
