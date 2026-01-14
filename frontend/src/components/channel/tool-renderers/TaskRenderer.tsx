/**
 * Task renderer - displays agent spawning and delegation.
 *
 * Shows:
 * - Subagent type
 * - Task description/prompt
 * - Model used (if specified)
 * - Status indicator (running/completed)
 * - Agent ID for resuming
 * - Background badge if run in background
 */
import { Bot, Clock } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

/**
 * Parse task output for metadata.
 */
function parseTaskOutput(output: unknown): {
  agentId?: string
  status?: string
  outputFile?: string
} {
  if (output && typeof output === 'object') {
    return {
      agentId: 'agentId' in output ? String(output.agentId) : undefined,
      status: 'status' in output ? String(output.status) : undefined,
      outputFile: 'outputFile' in output ? String(output.outputFile) : undefined,
    }
  }
  return {}
}

export function TaskRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const subagentType = (args.subagent_type as string) || 'general-purpose'
  const prompt = (args.prompt as string) || ''
  const description = (args.description as string) || undefined
  const model = (args.model as string) || undefined
  const runInBackground = (args.run_in_background as boolean) || false

  const taskData = parseTaskOutput(output)

  return (
    <div className="space-y-2">
      {/* Header with distinctive purple color for Task */}
      <div className="flex items-center gap-2">
        <Bot className="w-4 h-4 text-purple-500" />
        <span className="text-xs font-medium text-purple-500">Task</span>
        <span className="text-xs text-muted-foreground">→</span>
        <span className="text-xs font-medium">{subagentType}</span>
        {runInBackground && (
          <span className="px-2 py-0.5 text-[10px] font-semibold bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 uppercase tracking-wide">
            Background
          </span>
        )}
      </div>

      {/* Description (short summary) */}
      {description && (
        <div className="text-xs text-muted-foreground">
          {description}
        </div>
      )}

      {/* Prompt (full task description) */}
      {prompt && (
        <div className={cn(
          "text-xs bg-muted/50 p-2 border border-border",
          !isSuccess && "opacity-60"
        )}>
          <div className="text-muted-foreground">
            {prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {model && (
          <span>Model: {model}</span>
        )}
        {taskData.status && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {taskData.status}
          </span>
        )}
      </div>

      {/* Agent ID for resuming */}
      {taskData.agentId && (
        <div className="text-xs text-muted-foreground font-mono">
          Agent ID: {taskData.agentId}
        </div>
      )}

      {/* Output file for background tasks */}
      {taskData.outputFile && (
        <div className="text-xs text-muted-foreground">
          Output: {taskData.outputFile}
        </div>
      )}

      {/* Success indicator */}
      {isSuccess && !runInBackground && (
        <div className="text-xs text-green-600 dark:text-green-400">
          ✓ Task completed
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
