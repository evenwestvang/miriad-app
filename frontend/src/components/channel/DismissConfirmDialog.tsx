import { useEffect, useRef } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getSenderColor } from '../../utils'

interface DismissConfirmDialogProps {
  /** Callsign of agent to dismiss */
  callsign: string
  /** Whether the agent is currently active */
  isActive: boolean
  /** Called when user confirms dismissal */
  onConfirm: () => void
  /** Called when dialog is closed */
  onClose: () => void
  /** Whether dialog is open */
  isOpen: boolean
  /** Position relative to trigger button (bottom = distance from viewport bottom) */
  position?: { bottom: number; left: number }
}

/**
 * Confirmation dialog for dismissing active agents.
 * Only shown when agent is in thinking/tool_running state.
 */
export function DismissConfirmDialog({
  callsign,
  isActive,
  onConfirm,
  onClose,
  isOpen,
  position,
}: DismissConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    // Small delay to prevent immediate close from same click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      ref={dialogRef}
      className="fixed z-50 bg-card border border-border rounded-lg shadow-lg w-64"
      style={position ? { bottom: position.bottom, left: position.left } : undefined}
    >
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="font-medium text-base flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Dismiss agent?
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
          Dismiss{' '}
          <span className={cn("font-medium", getSenderColor(callsign))}>
            @{callsign}
          </span>
          {' '}from this channel?
        </p>

        {isActive && (
          <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>This agent is currently working. Dismissing will interrupt the task.</span>
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
            {isActive ? 'Dismiss Anyway' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  )
}
