import { ChevronRight, Check, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ToolActivity } from '../../types'

interface ToolActivityItemProps {
  tool: ToolActivity
  onToggleExpand: () => void
}

// Map internal tool names to user-friendly labels
const TOOL_LABELS: Record<string, { running: string; complete: string }> = {
  Read: { running: 'Reading', complete: 'Read' },
  Edit: { running: 'Editing', complete: 'Edited' },
  Write: { running: 'Writing', complete: 'Wrote' },
  Bash: { running: 'Running', complete: 'Ran' },
  Grep: { running: 'Searching', complete: 'Searched' },
  Glob: { running: 'Finding files', complete: 'Found files' },
  WebFetch: { running: 'Fetching', complete: 'Fetched' },
  WebSearch: { running: 'Searching web', complete: 'Searched web' },
  Task: { running: 'Delegating', complete: 'Delegated' },
  LSP: { running: 'Analyzing code', complete: 'Analyzed code' },
}

function getToolLabel(name: string, status: ToolActivity['status']): string {
  const labels = TOOL_LABELS[name]
  if (!labels) return name
  return status === 'running' ? labels.running : labels.complete
}

function truncate(str: string | undefined, maxLength: number): string {
  if (!str) return ''
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + '...'
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function StatusIcon({ status }: { status: ToolActivity['status'] }) {
  switch (status) {
    case 'running':
      return <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
    case 'complete':
      return <Check className="w-3 h-3 text-green-500" />
    case 'error':
      return <X className="w-3 h-3 text-red-500" />
  }
}

export function ToolActivityItem({ tool, onToggleExpand }: ToolActivityItemProps) {
  const hasOutput = !!tool.output

  return (
    <div className="px-3 py-2">
      <div
        className={cn(
          "flex items-center gap-2",
          hasOutput && "cursor-pointer hover:bg-secondary/30 -mx-1 px-1 rounded"
        )}
        onClick={hasOutput ? onToggleExpand : undefined}
      >
        {/* Status indicator */}
        <StatusIcon status={tool.status} />

        {/* Expand/collapse chevron */}
        {hasOutput ? (
          <ChevronRight
            className={cn(
              "w-3 h-3 transition-transform text-muted-foreground",
              tool.expanded && "rotate-90"
            )}
          />
        ) : (
          <div className="w-3" /> // Spacer when no output
        )}

        {/* Tool name */}
        <span
          className={cn(
            "font-mono text-base",
            tool.status === 'running' && "text-blue-500",
            tool.status === 'complete' && "text-muted-foreground",
            tool.status === 'error' && "text-red-500"
          )}
        >
          {getToolLabel(tool.name, tool.status)}
        </span>

        {/* Tool arguments (truncated) */}
        <span className="text-base text-muted-foreground truncate flex-1" title={tool.args}>
          {truncate(tool.args, 40)}
        </span>

        {/* Duration */}
        <span
          className={cn(
            "text-xs tabular-nums",
            tool.status === 'running' ? "text-blue-500" : "text-muted-foreground"
          )}
        >
          {formatElapsed(tool.elapsedSeconds)}
        </span>
      </div>

      {/* Expanded output */}
      {tool.expanded && tool.output && (
        <div className="mt-2 ml-6 p-2 bg-background rounded text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto">
          <pre className="whitespace-pre-wrap">{tool.output}</pre>
        </div>
      )}
    </div>
  )
}
