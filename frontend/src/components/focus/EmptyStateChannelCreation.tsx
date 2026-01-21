import { useState, useCallback } from 'react'
import { FocusPicker } from './FocusPicker'
import { cn } from '../../lib/utils'

interface EmptyStateChannelCreationProps {
  onCreate: (name: string, focusSlug: string | null) => Promise<void>
  apiHost?: string
}

export function EmptyStateChannelCreation({ onCreate, apiHost = '' }: EmptyStateChannelCreationProps) {
  const [channelName, setChannelName] = useState('')
  const [selectedFocus, setSelectedFocus] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    if (!channelName.trim()) return

    setIsCreating(true)
    setError(null)
    try {
      await onCreate(channelName.trim(), selectedFocus)
    } catch (err) {
      console.error('Failed to create channel:', err)
      setError('Failed to create channel. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }, [channelName, selectedFocus, onCreate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && channelName.trim() && !isCreating) {
      handleCreate()
    }
  }, [handleCreate, channelName, isCreating])

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div
        className="w-full max-w-[480px] bg-card border border-border rounded-lg p-6"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-lg font-semibold text-foreground mb-6">
          Create a new channel
        </h2>

        <div className="space-y-6">
          {/* Channel name input */}
          <div>
            <label className="block text-base font-medium text-foreground mb-2">
              Channel name
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 bg-secondary text-foreground text-base rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
              placeholder="my-project"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Focus picker */}
          <div>
            <label className="block text-base font-medium text-foreground mb-2">
              What's the focus?
            </label>
            <FocusPicker
              apiHost={apiHost}
              selected={selectedFocus}
              onSelect={setSelectedFocus}
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="text-base text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Action */}
        <div className="mt-6 pt-4 border-t border-border">
          <button
            type="button"
            className={cn(
              'w-full px-4 py-2 text-base rounded-md transition-colors',
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
