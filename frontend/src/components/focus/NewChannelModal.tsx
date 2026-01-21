import { useState, useCallback, useEffect, useRef, RefObject } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface NewChannelModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, focusSlug: string | null) => Promise<void>
  apiHost?: string
  anchorRef?: RefObject<HTMLButtonElement>
}

// Convert input to slug: lowercase, spaces to dashes, only allow a-z, 0-9, -
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')      // spaces to dashes
    .replace(/[^a-z0-9-]/g, '') // remove invalid chars
    .replace(/-+/g, '-')        // collapse multiple dashes
}

export function NewChannelModal({ isOpen, onClose, onCreate, anchorRef }: NewChannelModalProps) {
  const [channelName, setChannelName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const popoverRef = useRef<HTMLDivElement>(null)

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setChannelName(slugify(e.target.value))
  }

  // Calculate position based on anchor element
  useEffect(() => {
    if (isOpen && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      setPosition({
        top: rect.top,
        left: rect.right + 8, // 8px to the right of the button
      })
    }
  }, [isOpen, anchorRef])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef?.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }

    // Delay adding listener to avoid immediate close
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose, anchorRef])

  const handleClose = useCallback(() => {
    setChannelName('')
    onClose()
  }, [onClose])

  const handleCreate = useCallback(async () => {
    if (!channelName.trim()) return

    setIsCreating(true)
    try {
      await onCreate(channelName.trim(), null)
      handleClose()
    } catch (error) {
      console.error('Failed to create channel:', error)
    } finally {
      setIsCreating(false)
    }
  }, [channelName, onCreate, handleClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose()
    } else if (e.key === 'Enter' && channelName.trim() && !isCreating) {
      handleCreate()
    }
  }, [handleClose, handleCreate, channelName, isCreating])

  if (!isOpen) return null

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 bg-card border border-border rounded-lg p-4 w-[360px] shadow-lg"
      style={{ top: position.top, left: position.left }}
      onKeyDown={handleKeyDown}
    >
      {/* Header with title and close button */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium text-foreground">
          Create channel
        </h2>
        <button
          type="button"
          className="p-1 rounded hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleClose}
          disabled={isCreating}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Input and button on same line */}
      <div className="flex gap-2">
        <input
          type="text"
          className="flex-1 px-3 py-2 bg-secondary text-foreground text-base rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
          placeholder="channel-name"
          value={channelName}
          onChange={handleNameChange}
          autoFocus
        />
        <button
          type="button"
          className={cn(
            'px-4 py-2 text-base rounded-md transition-colors whitespace-nowrap',
            channelName.trim() && !isCreating
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-secondary text-muted-foreground cursor-not-allowed'
          )}
          onClick={handleCreate}
          disabled={!channelName.trim() || isCreating}
        >
          {isCreating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  )
}
