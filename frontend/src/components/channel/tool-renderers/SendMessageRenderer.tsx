/**
 * Send Message tool renderer - displays message sending operations.
 *
 * Shows:
 * - Full message content with markdown rendering
 * - Delivery status if available
 */
import { cn } from '../../../lib/utils'
import { useIsDarkMode } from '../../../hooks/useIsDarkMode'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

export function SendMessageRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const isDarkMode = useIsDarkMode()
  const normalized = normalizeArgs(args)

  const content = (normalized.content as string) || ''

  // Parse delivery info from output if available
  let deliveredTo: string[] = []
  if (output && typeof output === 'object' && 'delivered' in output) {
    deliveredTo = (output as { delivered: string[] }).delivered || []
  } else if (typeof output === 'string') {
    // Try to parse JSON output
    try {
      const parsed = JSON.parse(output)
      if (parsed.delivered) {
        deliveredTo = parsed.delivered
      }
    } catch {
      // Not JSON, ignore
    }
  }

  return (
    <div className="space-y-2">
      {/* Message content */}
      <div className={cn(
        "text-sm rounded p-3 whitespace-pre-wrap",
        isDarkMode ? "bg-[#282c34] text-[#abb2bf]" : "bg-[#fafafa] text-[#383a42]"
      )}>
        {content}
      </div>

      {/* Delivery status */}
      {isSuccess && deliveredTo.length > 0 && (
        <div className="text-xs text-muted-foreground">
          ✓ Delivered to {deliveredTo.map(d => `@${d}`).join(', ')}
        </div>
      )}

      {/* Error */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}
    </div>
  )
}
