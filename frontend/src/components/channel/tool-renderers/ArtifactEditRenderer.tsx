/**
 * artifact_edit renderer - displays artifact modifications.
 *
 * Shows:
 * - Artifact path
 * - Diff view (old_string → new_string)
 * - Before/after preview
 */
import { Edit } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

export function ArtifactEditRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const slug = (args.slug as string) || 'unknown'
  const oldString = (args.old_string as string) || ''
  const newString = (args.new_string as string) || ''

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Edit className="w-4 h-4" />
        <span className="text-xs font-medium text-[#de946a]">Edited artifact</span>
      </div>

      {/* Artifact path */}
      <div className="text-xs font-mono font-medium">
        /{slug}
      </div>

      {/* Diff view */}
      <div className={cn(
        "text-xs font-mono border border-border overflow-hidden",
        !isSuccess && "opacity-60"
      )}>
        {/* Removed lines */}
        {oldString && (
          <div className="bg-red-50 dark:bg-red-900/20 px-2 py-1">
            <span className="text-red-600 dark:text-red-400">- </span>
            <span className="text-red-700 dark:text-red-300">{oldString}</span>
          </div>
        )}
        {/* Added lines */}
        {newString && (
          <div className="bg-green-50 dark:bg-green-900/20 px-2 py-1">
            <span className="text-green-600 dark:text-green-400">+ </span>
            <span className="text-green-700 dark:text-green-300">{newString}</span>
          </div>
        )}
      </div>

      {/* Success confirmation */}
      {isSuccess && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ Artifact updated successfully
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
