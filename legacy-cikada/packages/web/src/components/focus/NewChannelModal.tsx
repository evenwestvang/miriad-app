import { useState, useCallback } from 'react'
import { FocusPicker } from './FocusPicker'
import { cn } from '../../lib/utils'

interface NewChannelModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, focusSlug: string | null) => Promise<void>
  apiHost?: string
}

export function NewChannelModal({ isOpen, onClose, onCreate, apiHost = '' }: NewChannelModalProps) {
  const [channelName, setChannelName] = useState('')
  const [selectedFocus, setSelectedFocus] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const handleClose = useCallback(() => {
    setChannelName('')
    setSelectedFocus(null)
    onClose()
  }, [onClose])

  const handleCreate = useCallback(async () => {
    if (!channelName.trim()) return

    setIsCreating(true)
    try {
      await onCreate(channelName.trim(), selectedFocus)
      handleClose()
    } catch (error) {
      console.error('Failed to create channel:', error)
    } finally {
      setIsCreating(false)
    }
  }, [channelName, selectedFocus, onCreate, handleClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose()
    } else if (e.key === 'Enter' && channelName.trim() && !isCreating) {
      handleCreate()
    }
  }, [handleClose, handleCreate, channelName, isCreating])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div
        className="relative bg-card border border-border rounded-lg p-6 w-[480px] max-h-[90vh] overflow-y-auto shadow-lg"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-lg font-semibold text-foreground mb-6">
          Create a new channel
        </h2>

        <div className="space-y-6">
          {/* Channel name input */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Channel name
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 bg-secondary text-foreground text-sm rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
              placeholder="my-project"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Focus picker */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              What's the focus?
            </label>
            <FocusPicker
              apiHost={apiHost}
              selected={selectedFocus}
              onSelect={setSelectedFocus}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            type="button"
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleClose}
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            type="button"
            className={cn(
              'px-4 py-2 text-sm rounded-md transition-colors',
              channelName.trim() && !isCreating
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-secondary text-muted-foreground cursor-not-allowed'
            )}
            onClick={handleCreate}
            disabled={!channelName.trim() || isCreating}
          >
            {isCreating ? 'Creating...' : 'Create Channel'}
          </button>
        </div>
      </div>
    </div>
  )
}
