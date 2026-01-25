import { cn } from '../../lib/utils'
import type { ArtifactStatus } from '../../types/artifact'

interface StatusIndicatorProps {
  status: ArtifactStatus
  className?: string
  /** Size in pixels, defaults to 6 */
  size?: number
}

/** Task-specific statuses that show colored dots */
const TASK_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'archived'] as const

/**
 * Status indicator dot for task artifacts only.
 *
 * Non-task statuses (draft/active/archived) use typography-based
 * treatment in the tree item itself, so no indicator is shown here.
 *
 * Task status colors:
 * - pending: gray
 * - in_progress: blue
 * - done: green
 * - blocked: red
 * - archived: gray (muted)
 */
export function StatusIndicator({ status, className, size = 6 }: StatusIndicatorProps) {
  // Only show indicator for task-specific statuses
  if (!TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) {
    return null
  }

  return (
    <span
      className={cn(
        'inline-block rounded-full flex-shrink-0',
        status === 'pending' && 'bg-[#8c8c8c]',
        status === 'in_progress' && 'bg-blue-500',
        status === 'done' && 'bg-green-500',
        status === 'blocked' && 'bg-red-500',
        status === 'archived' && 'bg-gray-500',
        className
      )}
      style={{ width: size, height: size }}
      title={status.replace('_', ' ')}
    />
  )
}
