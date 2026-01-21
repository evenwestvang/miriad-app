import { useState, useEffect, useRef } from 'react'
import { X, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import type { RosterAgent } from './MentionAutocomplete'

export interface AgentType {
  id: string
  name: string
  description?: string
}

interface AgentPickerProps {
  /** Available agent types to choose from */
  agentTypes: AgentType[]
  /** Current roster (for uniqueness validation) */
  roster: RosterAgent[]
  /** Channel ID for API calls */
  channelId: string
  /** API host */
  apiHost: string
  /** Called when agent is successfully added */
  onAgentAdded: (agent: RosterAgent) => void
  /** Called when picker is closed */
  onClose: () => void
  /** Whether picker is open */
  isOpen: boolean
}

// Callsign suggestions based on agent type
const callsignSuggestions: Record<string, string[]> = {
  'claude-code': ['fox', 'owl', 'raven', 'wolf', 'bear'],
  'engineer': ['fox', 'bear', 'elk', 'hawk'],
  'reviewer': ['owl', 'eagle', 'falcon'],
  'default': ['alpha', 'beta', 'gamma', 'delta'],
}

function getSuggestion(typeId: string, roster: RosterAgent[]): string {
  const suggestions = callsignSuggestions[typeId] || callsignSuggestions.default
  const taken = new Set(roster.map(r => r.callsign))
  return suggestions.find(s => !taken.has(s)) || ''
}

/**
 * Popover for adding a new agent to the channel roster.
 * Shows type dropdown and callsign input with validation.
 */
export function AgentPicker({
  agentTypes,
  roster,
  channelId,
  apiHost,
  // onAgentAdded - called via WebSocket event instead
  onClose,
  isOpen,
}: AgentPickerProps) {
  const [selectedType, setSelectedType] = useState<string>(agentTypes[0]?.id || '')
  const [callsign, setCallsign] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Auto-suggest callsign when type changes
  useEffect(() => {
    if (selectedType) {
      const suggestion = getSuggestion(selectedType, roster)
      setCallsign(suggestion)
      setError(null)
    }
  }, [selectedType, roster])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
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

  // Validate callsign
  const validateCallsign = (value: string): string | null => {
    if (!value.trim()) {
      return 'Callsign is required'
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
      return 'Lowercase letters, numbers, and hyphens only'
    }
    if (roster.some(a => a.callsign === value)) {
      return 'Callsign already in use'
    }
    return null
  }

  const handleCallsignChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    setCallsign(normalized)
    setError(validateCallsign(normalized))
  }

  const handleSubmit = async () => {
    const validationError = validateCallsign(callsign)
    if (validationError) {
      setError(validationError)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: selectedType,
          callsign,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Failed to add agent: ${response.status}`)
      }

      // Success - close picker (roster will update via WebSocket event)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add agent')
    } finally {
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      ref={popoverRef}
      className="absolute top-full right-0 mt-1 w-64 bg-card border border-border rounded-lg shadow-lg z-50"
    >
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="font-medium text-base">Add Agent</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* Type dropdown */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Type</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="w-full px-2 py-1.5 text-base bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            disabled={isLoading}
          >
            {agentTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          {agentTypes.find(t => t.id === selectedType)?.description && (
            <p className="text-xs text-muted-foreground mt-1">
              {agentTypes.find(t => t.id === selectedType)?.description}
            </p>
          )}
        </div>

        {/* Callsign input */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Callsign</label>
          <input
            ref={inputRef}
            type="text"
            value={callsign}
            onChange={(e) => handleCallsignChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !error && callsign) {
                handleSubmit()
              }
            }}
            placeholder="e.g., owl"
            className={cn(
              "w-full px-2 py-1.5 text-base bg-background border rounded focus:outline-none focus:ring-1",
              error
                ? "border-destructive focus:ring-destructive"
                : "border-border focus:ring-primary"
            )}
            disabled={isLoading}
          />
          {error && (
            <p className="text-xs text-destructive mt-1">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded hover:bg-secondary/50 text-muted-foreground"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || !!error || !callsign}
            className={cn(
              "px-3 py-1.5 text-xs rounded font-medium flex items-center gap-1",
              isLoading || error || !callsign
                ? "bg-secondary text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
