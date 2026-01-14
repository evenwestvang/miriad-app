/**
 * Glob tool renderer - displays file pattern matching results.
 *
 * Shows:
 * - Pattern used
 * - Result count
 * - File list (with paths)
 * - Sorted by recency (most recent first)
 */
import { File, FileCode } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

const MAX_FILES_PREVIEW = 50

/**
 * Parse glob output into file list.
 */
function parseGlobOutput(output: unknown): string[] {
  if (typeof output === 'string') {
    // Split by newlines and filter empty
    return output.split('\n').filter(line => line.trim())
  }
  if (Array.isArray(output)) {
    return output.map(String)
  }
  if (output && typeof output === 'object' && 'files' in output) {
    const files = (output as { files: unknown }).files
    if (Array.isArray(files)) {
      return files.map(String)
    }
  }
  return []
}

/**
 * Get file icon component based on extension.
 */
function getFileIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const codeExtensions = ['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'java', 'go', 'rs', 'php', 'c', 'cpp', 'cs', 'kt', 'swift']

  if (codeExtensions.includes(ext || '')) {
    return <FileCode className="w-4 h-4 text-muted-foreground" />
  }
  return <File className="w-4 h-4 text-muted-foreground" />
}

/**
 * Truncate path to show just the filename and relevant parent dirs.
 */
function truncatePath(path: string, maxDirs: number = 3): string {
  const parts = path.split('/')
  if (parts.length <= maxDirs) {
    return path
  }
  return '.../' + parts.slice(-maxDirs).join('/')
}

export function GlobRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const pattern = (args.pattern as string) || '*'
  const path = (args.path as string) || undefined

  const files = parseGlobOutput(output)
  const totalFiles = files.length
  const filesToShow = files.slice(0, MAX_FILES_PREVIEW)
  const hasMore = totalFiles > MAX_FILES_PREVIEW

  return (
    <div className="space-y-2">
      {/* Pattern header */}
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">Pattern:</span>
        <span className="font-mono font-medium">{pattern}</span>
        {path && (
          <>
            <span className="text-muted-foreground">in</span>
            <span className="font-mono text-muted-foreground">{path}</span>
          </>
        )}
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground">
        {totalFiles === 0 ? (
          <span>No files found</span>
        ) : (
          <span className="text-green-600 dark:text-green-400 font-medium">
            Found {totalFiles} {totalFiles === 1 ? 'file' : 'files'}
          </span>
        )}
      </div>

      {/* File list */}
      {totalFiles > 0 && (
        <div className={cn(
          "rounded border border-border overflow-hidden",
          !isSuccess && "border-red-200 dark:border-red-800 opacity-60"
        )}>
          <div className="max-h-64 overflow-y-auto">
            {filesToShow.map((file, index) => (
              <div
                key={index}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-muted/50",
                  index !== filesToShow.length - 1 && "border-b border-border"
                )}
              >
                <span className="flex-shrink-0">{getFileIcon(file)}</span>
                <span className="text-muted-foreground truncate" title={file}>
                  {truncatePath(file)}
                </span>
              </div>
            ))}
            {hasMore && (
              <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/30 border-t border-border">
                ... and {totalFiles - MAX_FILES_PREVIEW} more files
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error message if failed */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}
    </div>
  )
}
