/**
 * Edit tool renderer - displays file editing operations.
 *
 * Shows:
 * - File path with copy button
 * - Unified diff view (like git diff)
 * - Color coding: red for removed, green for added, no color for context
 */
import { useState, useMemo } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

/**
 * Compute a unified diff between two strings using a simple LCS-based algorithm.
 * Returns an array of diff lines with type: 'context' | 'removed' | 'added'
 */
function computeDiff(oldStr: string, newStr: string): Array<{ type: 'context' | 'removed' | 'added'; line: string }> {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  // Build LCS table
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  let i = m
  let j = n

  // Collect operations in reverse order
  const ops: Array<{ type: 'context' | 'removed' | 'added'; line: string }> = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'context', line: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', line: newLines[j - 1] })
      j--
    } else {
      ops.push({ type: 'removed', line: oldLines[i - 1] })
      i--
    }
  }

  // Reverse to get correct order
  return ops.reverse()
}

export function EditRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const [copied, setCopied] = useState(false)

  const filePath = (args.file_path as string) || (args.path as string) || 'unknown'
  const oldString = (args.old_string as string) || ''
  const newString = (args.new_string as string) || ''
  const replaceAll = (args.replace_all as boolean) || false

  // Compute the diff
  const diffLines = useMemo(() => computeDiff(oldString, newString), [oldString, newString])

  // Count changes
  const removedCount = diffLines.filter(d => d.type === 'removed').length
  const addedCount = diffLines.filter(d => d.type === 'added').length

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
        {replaceAll ? 'Replaced all occurrences' : `−${removedCount} +${addedCount}`}
      </div>

      {/* Diff view */}
      <div className={cn(
        "text-xs font-mono border border-border overflow-hidden overflow-x-auto",
        !isSuccess && "border-red-200 dark:border-red-800 opacity-60"
      )}>
        {diffLines.map((diff, index) => (
          <div
            key={index}
            className={cn(
              "px-3 py-0.5 whitespace-pre",
              diff.type === 'removed' && "bg-red-50 dark:bg-red-900/20",
              diff.type === 'added' && "bg-green-50 dark:bg-green-900/20"
            )}
          >
            <span className={cn(
              "select-none mr-2 inline-block w-3",
              diff.type === 'removed' && "text-red-600 dark:text-red-400",
              diff.type === 'added' && "text-green-600 dark:text-green-400",
              diff.type === 'context' && "text-muted-foreground"
            )}>
              {diff.type === 'removed' ? '−' : diff.type === 'added' ? '+' : ' '}
            </span>
            <span className={cn(
              diff.type === 'removed' && "text-red-700 dark:text-red-300",
              diff.type === 'added' && "text-green-700 dark:text-green-300",
              diff.type === 'context' && "text-foreground"
            )}>
              {diff.line}
            </span>
          </div>
        ))}
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
