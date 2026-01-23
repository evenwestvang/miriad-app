import { cn } from '../../lib/utils'
import type { ArtifactStatus } from '../../types/artifact'

interface StatusIndicatorProps {
  status: ArtifactStatus
  className?: string
  /** Size in pixels, defaults to 6 */
  size?: number
}

/**
 * Status indicator dot/ring for artifacts.
 * - Filled dot: published, pending, in_progress, done, blocked
 * - Ring (outline): draft
 * - No indicator: archived
 */
export function StatusIndicator({ status, className, size = 6 }: StatusIndicatorProps) {
  // Archived gets no indicator
  if (status === 'archived') {
    return null
  }

  const isRing = status === 'draft'

  return (
    <span
      className={cn(
        'inline-block rounded-full flex-shrink-0',
        // Ring vs filled
        isRing ? 'border-[1.5px]' : '',
        // Status colors
        status === 'draft' && 'border-[#de946a]',
        status === 'published' && 'bg-green-500',
        status === 'pending' && 'bg-[#8c8c8c]',
        status === 'in_progress' && 'bg-blue-500',
        status === 'done' && 'bg-green-500',
        status === 'blocked' && 'bg-red-500',
        className
      )}
      style={{ width: size, height: size }}
      title={status.replace('_', ' ')}
    />
  )
}
