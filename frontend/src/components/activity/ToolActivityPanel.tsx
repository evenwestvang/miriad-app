import { Activity } from 'lucide-react'
import { ToolActivityItem } from './ToolActivityItem'
import type { ToolActivity } from '../../types'

interface ToolActivityPanelProps {
  tools: ToolActivity[]
  isComplete: boolean
  summary?: { durationMs: number; numTurns: number }
  onToggleExpand: (toolId: string) => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

export function ToolActivityPanel({
  tools,
  isComplete,
  summary,
  onToggleExpand
}: ToolActivityPanelProps) {
  if (tools.length === 0) return null

  return (
    <div className="border border-border rounded-lg my-2 bg-card/50">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Activity className="w-4 h-4 text-muted-foreground" />
        <span className="text-base font-medium">Agent Activity</span>
        {isComplete && summary && (
          <span className="text-xs text-muted-foreground ml-auto">
            {formatDuration(summary.durationMs)}
          </span>
        )}
        {!isComplete && (
          <span className="ml-auto">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse inline-block" />
          </span>
        )}
      </div>
      <div className="divide-y divide-border">
        {tools.map(tool => (
          <ToolActivityItem
            key={tool.id}
            tool={tool}
            onToggleExpand={() => onToggleExpand(tool.id)}
          />
        ))}
      </div>
    </div>
  )
}
