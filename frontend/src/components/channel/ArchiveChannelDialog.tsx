import { useEffect, useRef } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface ArchiveChannelDialogProps {
  /** Name of the channel to archive */
  channelName: string
  /** Number of active (non-archived) agents that will be dismissed */
  activeAgentCount: number
  /** Called when user confirms archival */
  onConfirm: () => void
  /** Called when dialog is closed */
  onClose: () => void
}

/**
 * Confirmation dialog for archiving a channel.
 * Warns about active agents being dismissed.
 */
export function ArchiveChannelDialog({
  channelName,
  activeAgentCount,
  onConfirm,
  onClose,
}: ArchiveChannelDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        className="bg-card border border-border rounded-lg shadow-lg w-80"
      >
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between">
            <span className="font-medium text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Archive channel?
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-3 space-y-3">
          <p className="text-base text-muted-foreground">
            Archive <span className="font-medium text-foreground">#{channelName}</span>? The channel will be hidden from the sidebar.
          </p>

          {activeAgentCount > 0 && (
            <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                {activeAgentCount} active {activeAgentCount === 1 ? 'agent' : 'agents'} will be dismissed.
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded hover:bg-secondary/50 text-muted-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onConfirm()
                onClose()
              }}
              className="px-3 py-1.5 text-xs rounded font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Archive Channel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
