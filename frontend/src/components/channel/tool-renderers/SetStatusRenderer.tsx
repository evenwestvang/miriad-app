/**
 * set_status renderer - displays agent status updates.
 *
 * Shows:
 * - New status text
 * - Timestamp
 * - Simple, non-intrusive display
 */
import { Activity } from 'lucide-react'
import type { ToolRendererProps } from './types'

export function SetStatusRenderer({ args, error, isSuccess }: ToolRendererProps) {
  const status = (args.status as string) || ''

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Activity className="w-3 h-3" />
      <span>Status updated:</span>
      <span className="font-medium text-foreground">"{status}"</span>
      {!isSuccess && error && (
        <span className="text-red-500 dark:text-red-400">({error})</span>
      )}
    </div>
  )
}
