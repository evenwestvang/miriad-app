import { useState, useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { createChannel, fetchFocusTypes, FocusType } from '@/api'
import { cn } from '@/lib/utils'

interface EmptyStateChannelCreationProps {
  userName?: string
  onChannelCreated?: (channelName: string) => void
}

export function EmptyStateChannelCreation({
  userName,
  onChannelCreated,
}: EmptyStateChannelCreationProps) {
  const [name, setName] = useState('')
  const [selectedFocus, setSelectedFocus] = useState<string>('open')
  const [focusTypes, setFocusTypes] = useState<FocusType[]>([])
  const [loadingFocus, setLoadingFocus] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load focus types on mount
  useEffect(() => {
    fetchFocusTypes()
      .then(types => {
        setFocusTypes(types)
        // Default to 'open' if available, else first option
        if (types.length > 0) {
          const hasOpen = types.some(t => t.slug === 'open')
          setSelectedFocus(hasOpen ? 'open' : types[0].slug)
        }
      })
      .catch(console.error)
      .finally(() => setLoadingFocus(false))
  }, [])

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleCreate = async () => {
    if (!name.trim() || creating) return

    const channelName = name.trim()

    setCreating(true)
    setError(null)
    try {
      await createChannel(
        channelName,
        userName ? { createdBy: userName } : undefined,
        selectedFocus
      )
      // Navigate to the new channel
      window.location.hash = `c/${encodeURIComponent(channelName)}`
      onChannelCreated?.(channelName)
    } catch (err) {
      console.error('Failed to create channel:', err)
      const message = err instanceof Error ? err.message : 'Failed to create channel'
      setError(message)
      setCreating(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-[480px] space-y-6">
        {/* Title */}
        <h1 className="text-xl font-semibold">Create a new channel</h1>

        {/* Channel name input */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Channel name</label>
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                handleCreate()
              }
            }}
            className="h-11"
          />
        </div>

        {/* Focus picker */}
        <div className="space-y-2">
          <label className="text-sm font-medium">What's the focus?</label>
          {loadingFocus ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Loading focus options...
            </div>
          ) : focusTypes.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No focus types available
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {focusTypes.map((focus) => {
                const isSelected = selectedFocus === focus.slug
                return (
                  <button
                    key={focus.slug}
                    type="button"
                    onClick={() => setSelectedFocus(focus.slug)}
                    className={cn(
                      'relative p-3 rounded-lg border text-left transition-colors min-h-[90px]',
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-muted-foreground/50 hover:bg-secondary/50'
                    )}
                  >
                    {/* Selection indicator */}
                    {isSelected && (
                      <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                        <Check className="h-3 w-3 text-primary-foreground" />
                      </div>
                    )}

                    <div className="space-y-1 pr-6">
                      <div className={cn(
                        'font-medium text-sm',
                        isSelected ? 'text-primary' : 'text-foreground'
                      )}>
                        {focus.title}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {focus.tldr}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {error && (
          <div className="text-sm text-red-500">{error}</div>
        )}

        {/* Create button */}
        <Button
          onClick={handleCreate}
          disabled={!name.trim() || creating}
          className="w-full"
        >
          {creating ? 'Creating...' : 'Create Channel'}
        </Button>
      </div>
    </div>
  )
}
