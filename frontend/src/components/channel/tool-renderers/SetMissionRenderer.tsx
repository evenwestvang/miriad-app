/**
 * Set Mission renderer - displays the agent's current mission/objective.
 *
 * Shows:
 * - Mission text in a prominent, readable format
 * - Clear visual indicator that this is the agent's focus
 */
import { Target } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

export function SetMissionRenderer({ args, isSuccess }: ToolRendererProps) {
  const normalized = normalizeArgs(args)
  const mission = (normalized.mission as string) || null

  // Mission being cleared
  if (mission === null || mission === '') {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Target className="w-4 h-4" />
        <span className="text-sm italic">Mission cleared</span>
      </div>
    )
  }

  return (
    <div className={cn(
      "rounded-md overflow-hidden",
      !isSuccess && "opacity-60"
    )}>
      {/* Header */}
      <div className="flex items-center gap-2 py-1.5">
        <Target className="w-4 h-4 text-blue-500" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mission</span>
      </div>
      
      {/* Mission text */}
      <div className="py-1">
        <p className="text-sm">{mission}</p>
      </div>
    </div>
  )
}
