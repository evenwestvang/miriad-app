import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'

export interface FocusType {
  slug: string
  title: string
  tldr: string
}

interface FocusPickerProps {
  apiHost?: string
  selected: string | null
  onSelect: (slug: string) => void
}

export function FocusPicker({ apiHost = '', selected, onSelect }: FocusPickerProps) {
  const [focusTypes, setFocusTypes] = useState<FocusType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchFocusTypes() {
      try {
        const response = await apiFetch(`${apiHost}/focus-types`)
        if (!response.ok) {
          throw new Error(`Failed to fetch focus types: ${response.status}`)
        }
        const data = await response.json()
        // API returns { focusTypes: [...] } wrapper
        const types = data.focusTypes || data
        setFocusTypes(types)

        // Default to 'open' if available and nothing selected
        if (!selected && types.length > 0) {
          const hasOpen = types.some((t: FocusType) => t.slug === 'open')
          onSelect(hasOpen ? 'open' : types[0].slug)
        }
      } catch (err) {
        console.error('Failed to fetch focus types:', err)
        setError('Failed to load focus types')
        setFocusTypes([])
      } finally {
        setLoading(false)
      }
    }

    fetchFocusTypes()
  }, [apiHost, selected, onSelect])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-base text-muted-foreground">
        Loading focus options...
      </div>
    )
  }

  if (error || focusTypes.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-base text-muted-foreground">
        {error || 'No focus types available'}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {focusTypes.map((focus) => (
        <button
          key={focus.slug}
          type="button"
          onClick={() => onSelect(focus.slug)}
          className={cn(
            'relative flex flex-col items-start p-3 rounded-lg border text-left transition-colors min-h-[90px]',
            'hover:bg-secondary/50',
            selected === focus.slug
              ? 'border-primary bg-primary/5'
              : 'border-border'
          )}
        >
          {selected === focus.slug && (
            <div className="absolute top-2 right-2">
              <Check className="w-4 h-4 text-primary" />
            </div>
          )}
          <span className="font-medium text-base text-foreground">
            {focus.title}
          </span>
          <span className="text-xs text-muted-foreground line-clamp-2 mt-1">
            {focus.tldr}
          </span>
        </button>
      ))}
    </div>
  )
}
