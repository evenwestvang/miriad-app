import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createChannel, fetchFocusTypes, FocusType } from '@/api'
import { cn } from '@/lib/utils'

interface NewChannelModalProps {
  open: boolean
  onClose: () => void
  userName?: string
}

export function NewChannelModal({
  open,
  onClose,
  userName,
}: NewChannelModalProps) {
  const [name, setName] = useState('')
  const [selectedFocus, setSelectedFocus] = useState<string>('open')
  const [focusTypes, setFocusTypes] = useState<FocusType[]>([])
  const [loadingFocus, setLoadingFocus] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load focus types and reset form when modal opens
  useEffect(() => {
    if (open) {
      setName('')
      setSelectedFocus('open')
      setCreating(false)
      setError(null)
      setLoadingFocus(true)
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
    }
  }, [open])

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
      onClose()
      window.location.hash = `c/${encodeURIComponent(channelName)}`
    } catch (err) {
      console.error('Failed to create channel:', err)
      const message = err instanceof Error ? err.message : 'Failed to create channel'
      setError(message)
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create a new channel</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Channel name input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Channel name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  handleCreate()
                }
              }}
            />
          </div>

          {/* Focus picker */}
          <div className="space-y-2">
            <label className="text-sm font-medium">What's the focus?</label>
            {loadingFocus ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
                Loading focus options...
              </div>
            ) : focusTypes.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
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
                        'relative p-3 rounded-lg border text-left transition-colors',
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? 'Creating...' : 'Create Channel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
