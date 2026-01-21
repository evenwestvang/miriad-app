import { useState, useCallback } from 'react'
import { Archive, Undo2 } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface ArchivedItem {
  slug: string
  previousStatus: string
}

interface ArchiveToastProps {
  /** Items that were archived (for display and undo) */
  archivedItems: ArchivedItem[]
  /** Called when user clicks undo */
  onUndo: (items: ArchivedItem[]) => Promise<void>
  /** Called when toast is dismissed */
  onDismiss: () => void
}

/**
 * Persistent banner shown after archiving artifacts.
 * Appears at bottom of board panel with undo action.
 * Stays until user takes another action (select, create, close panel).
 */
export function ArchiveToast({
  archivedItems,
  onUndo,
  onDismiss,
}: ArchiveToastProps) {
  const [isUndoing, setIsUndoing] = useState(false)

  // Handle undo click
  const handleUndo = useCallback(async () => {
    setIsUndoing(true)
    try {
      await onUndo(archivedItems)
    } finally {
      onDismiss()
    }
  }, [archivedItems, onUndo, onDismiss])

  // Display text
  const itemCount = archivedItems.length
  const displayText = itemCount === 1
    ? `Archived "${archivedItems[0].slug}"`
    : `Archived ${itemCount} items`

  return (
    <div
      className={cn(
        "absolute bottom-3 left-3 right-3 z-50",
        "bg-card border border-border rounded-lg shadow-lg",
        "animate-in slide-in-from-bottom-2 duration-200"
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Icon */}
        <Archive className="w-4 h-4 text-muted-foreground flex-shrink-0" />

        {/* Message */}
        <span className="flex-1 text-base text-foreground truncate">
          {displayText}
        </span>

        {/* Undo button */}
        <button
          onClick={handleUndo}
          disabled={isUndoing}
          className={cn(
            "flex items-center gap-1 px-2 py-1 text-base rounded",
            "text-primary hover:bg-primary/10 transition-colors",
            isUndoing && "opacity-50 cursor-not-allowed"
          )}
        >
          <Undo2 className="w-3 h-3" />
          {isUndoing ? 'Undoing...' : 'Undo'}
        </button>
      </div>
    </div>
  )
}
