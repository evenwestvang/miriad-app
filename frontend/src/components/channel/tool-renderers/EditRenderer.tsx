/**
 * Edit tool renderer - displays file editing operations.
 *
 * Shows:
 * - File path with copy button
 * - Diff view (old_string → new_string)
 * - Context lines with line numbers
 * - Color coding: red for removed, green for added
 */
import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

export function EditRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const [copied, setCopied] = useState(false)

  const filePath = (args.file_path as string) || (args.path as string) || 'unknown'
  const oldString = (args.old_string as string) || ''
  const newString = (args.new_string as string) || ''
  const replaceAll = (args.replace_all as boolean) || false

  const handleCopy = async () => {
    await navigator.clipboard.writeText(filePath)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-2">
      {/* File path header with copy button */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground">{filePath}</span>
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-muted transition-colors"
          title="Copy file path"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-500" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* Metadata */}
      <div className="text-xs text-muted-foreground">
        {replaceAll ? 'Replaced all occurrences' : '1 change'}
      </div>

      {/* Diff view */}
      <div className={cn(
        "text-xs font-mono border border-border overflow-hidden",
        !isSuccess && "border-red-200 dark:border-red-800 opacity-60"
      )}>
        {/* Removed lines */}
        {oldString && (
          <div className="bg-red-50 dark:bg-red-900/20 px-3 py-1.5 border-b border-border">
            <span className="text-red-600 dark:text-red-400 select-none mr-2">-</span>
            <span className="text-red-700 dark:text-red-300">{oldString}</span>
          </div>
        )}
        {/* Added lines */}
        {newString && (
          <div className="bg-green-50 dark:bg-green-900/20 px-3 py-1.5">
            <span className="text-green-600 dark:text-green-400 select-none mr-2">+</span>
            <span className="text-green-700 dark:text-green-300">{newString}</span>
          </div>
        )}
      </div>

      {/* Success confirmation */}
      {isSuccess && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ File edited successfully
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
