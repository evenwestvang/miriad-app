import { useState, useEffect, useRef } from 'react'
import { Pencil, X } from 'lucide-react'

interface RenameChannelDialogProps {
  /** Current name of the channel */
  currentName: string
  /** Called with the new name when user confirms */
  onConfirm: (newName: string) => void
  /** Called when dialog is closed */
  onClose: () => void
}

/**
 * Dialog for renaming a channel.
 * Pre-fills with current name, Enter to confirm, Escape to cancel.
 */
export function RenameChannelDialog({
  currentName,
  onConfirm,
  onClose,
}: RenameChannelDialogProps) {
  const [name, setName] = useState(currentName)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus and select input text on mount
  useEffect(() => {
    inputRef.current?.select()
  }, [])

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

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && trimmedName !== currentName

  const handleSubmit = () => {
    if (!canSubmit) return
    onConfirm(trimmedName)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        className="bg-card border border-border rounded-lg shadow-lg w-80"
      >
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between">
            <span className="font-medium text-base flex items-center gap-2">
              <Pencil className="w-4 h-4 text-muted-foreground" />
              Rename channel
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
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
            className="w-full px-3 py-1.5 text-base bg-secondary text-foreground rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
            placeholder="Channel name"
            autoFocus
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded hover:bg-secondary/50 text-muted-foreground"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`px-3 py-1.5 text-xs rounded font-medium ${
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-secondary text-muted-foreground cursor-not-allowed'
              }`}
            >
              Rename
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
