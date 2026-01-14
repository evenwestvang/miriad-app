import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Loader2, Search, ChevronLeft, CircleDashed, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import type { RosterAgent } from './MentionAutocomplete'

/**
 * Runtime available for running agents.
 */
interface RuntimeOption {
  id: string
  name: string
  status: 'online' | 'offline'
}

/**
 * Available agent definition from the API.
 * Merged from channel board + root channel (local shadows root by slug).
 */
export interface AvailableAgent {
  slug: string
  title?: string
  tldr: string
  nameTheme?: string
  suggestedName?: string
  source: 'local' | 'root'
}

interface AgentSummonPickerProps {
  /** Current roster (for callsign uniqueness validation) */
  roster: RosterAgent[]
  /** Channel ID for API calls */
  channelId: string
  /** Space ID for fetching runtimes */
  spaceId?: string
  /** API host */
  apiHost: string
  /** Called when picker is closed */
  onClose: () => void
  /** Whether picker is open */
  isOpen: boolean
}

type PickerState = 'browse' | 'configure'

// Local storage key for remembering the last used runtime
const LAST_RUNTIME_KEY = 'cast:lastUsedRuntime'

/**
 * Get the last used runtime ID from local storage.
 */
function getLastUsedRuntime(): string | null {
  try {
    return localStorage.getItem(LAST_RUNTIME_KEY)
  } catch {
    return null
  }
}

/**
 * Save the last used runtime ID to local storage.
 */
function setLastUsedRuntime(runtimeId: string): void {
  try {
    localStorage.setItem(LAST_RUNTIME_KEY, runtimeId)
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get suggested callsign for an agent, avoiding duplicates.
 */
function getSuggestedCallsign(agent: AvailableAgent, roster: RosterAgent[]): string {
  const taken = new Set(roster.map(r => r.callsign))

  // Use suggestedName if available and not taken
  if (agent.suggestedName && !taken.has(agent.suggestedName)) {
    return agent.suggestedName
  }

  // Fall back to default list
  const defaults = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  return defaults.find(name => !taken.has(name)) || ''
}

/**
 * Popover for summoning a new agent to the channel roster.
 * Two-step flow: browse available agents -> configure callsign.
 */
export function AgentSummonPicker({
  roster,
  channelId,
  spaceId,
  apiHost,
  onClose,
  isOpen,
}: AgentSummonPickerProps) {
  // State
  const [state, setState] = useState<PickerState>('browse')
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([])
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Browse state
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Configure state
  const [selectedAgent, setSelectedAgent] = useState<AvailableAgent | null>(null)
  const [callsign, setCallsign] = useState('')
  const [callsignError, setCallsignError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Runtime state
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>('cloud')
  const [isLoadingRuntimes, setIsLoadingRuntimes] = useState(false)

  // Refs
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const callsignInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter agents by search query
  const filteredAgents = availableAgents.filter(agent => {
    const query = searchQuery.toLowerCase()
    return (
      agent.slug.toLowerCase().includes(query) ||
      agent.title?.toLowerCase().includes(query) ||
      agent.tldr.toLowerCase().includes(query)
    )
  })

  // Reset state when picker opens/closes
  useEffect(() => {
    if (isOpen) {
      setState('browse')
      setSearchQuery('')
      setSelectedIndex(0)
      setSelectedAgent(null)
      setCallsign('')
      setCallsignError(null)
      // Note: selectedRuntimeId is set by fetchRuntimes based on last used / availability
      fetchAvailableAgents()
      fetchRuntimes()
    }
  }, [isOpen])

  // Focus search input when in browse state
  useEffect(() => {
    if (isOpen && state === 'browse' && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [isOpen, state])

  // Focus callsign input when in configure state
  useEffect(() => {
    if (isOpen && state === 'configure' && callsignInputRef.current) {
      callsignInputRef.current.focus()
    }
  }, [isOpen, state])

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchQuery])

  // Scroll selected item into view when navigating with keyboard
  useEffect(() => {
    if (listRef.current && state === 'browse') {
      const selectedElement = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex, state])

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

  // Fetch available agents from API
  const fetchAvailableAgents = useCallback(async () => {
    setIsLoadingAgents(true)
    setLoadError(null)

    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/agents/available`)

      if (!response.ok) {
        throw new Error('Failed to load available agents')
      }

      const data = await response.json()
      setAvailableAgents(data.agents || [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load agents')
      setAvailableAgents([])
    } finally {
      setIsLoadingAgents(false)
    }
  }, [apiHost, channelId])

  // Fetch available runtimes from API and select the remembered runtime
  const fetchRuntimes = useCallback(async () => {
    if (!spaceId) {
      setRuntimes([])
      return
    }

    setIsLoadingRuntimes(true)

    try {
      const response = await apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes`)

      if (!response.ok) {
        console.warn('Failed to load runtimes')
        setRuntimes([])
        return
      }

      const data = await response.json()
      // Only include online runtimes as options
      const onlineRuntimes = (data.runtimes || []).filter(
        (r: RuntimeOption) => r.status === 'online'
      )
      setRuntimes(onlineRuntimes)

      // Select the last used runtime if available, otherwise fall back to first available
      const lastUsed = getLastUsedRuntime()
      const availableIds = ['cloud', ...onlineRuntimes.map((r: RuntimeOption) => r.id)]

      if (lastUsed && availableIds.includes(lastUsed)) {
        setSelectedRuntimeId(lastUsed)
      } else if (onlineRuntimes.length > 0) {
        // Fall back to first available runtime
        setSelectedRuntimeId(onlineRuntimes[0].id)
      } else {
        // Fall back to cloud
        setSelectedRuntimeId('cloud')
      }
    } catch (err) {
      console.warn('Failed to load runtimes:', err)
      setRuntimes([])
    } finally {
      setIsLoadingRuntimes(false)
    }
  }, [apiHost, spaceId])

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
    setCallsignError(validateCallsign(normalized))
  }

  // Select an agent and go to configure state
  const handleSelectAgent = (agent: AvailableAgent) => {
    setSelectedAgent(agent)
    const suggested = getSuggestedCallsign(agent, roster)
    setCallsign(suggested)
    setCallsignError(validateCallsign(suggested))
    setState('configure')
  }

  // Go back to browse state
  const handleBack = () => {
    setState('browse')
    setSelectedAgent(null)
    setCallsign('')
    setCallsignError(null)
  }

  // Submit - spawn the agent
  const handleSubmit = async () => {
    if (!selectedAgent) return

    const validationError = validateCallsign(callsign)
    if (validationError) {
      setCallsignError(validationError)
      return
    }

    setIsSubmitting(true)
    setCallsignError(null)

    try {
      // Build request body - only include runtimeId if not using cloud
      const requestBody: Record<string, string> = {
        agentType: selectedAgent.slug,
        callsign,
      }
      if (selectedRuntimeId !== 'cloud') {
        requestBody.runtimeId = selectedRuntimeId
      }

      const response = await apiFetch(`${apiHost}/channels/${channelId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Failed to summon agent: ${response.status}`)
      }

      // Remember the runtime selection for next time
      setLastUsedRuntime(selectedRuntimeId)

      // Success - close picker (roster will update via WebSocket event)
      onClose()
    } catch (err) {
      setCallsignError(err instanceof Error ? err.message : 'Failed to summon agent')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (state === 'browse') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, filteredAgents.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && filteredAgents[selectedIndex]) {
        e.preventDefault()
        handleSelectAgent(filteredAgents[selectedIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    } else if (state === 'configure') {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleBack()
      } else if (e.key === 'Enter' && !callsignError && callsign) {
        e.preventDefault()
        handleSubmit()
      }
    }
  }

  if (!isOpen) return null

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-4 mb-1 w-72 bg-card border border-border rounded-lg shadow-lg z-50"
      onKeyDown={handleKeyDown}
    >
      {state === 'browse' ? (
        <>
          {/* Search header */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search agents..."
                className="w-full pl-8 pr-8 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-secondary/50 text-muted-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Agent list */}
          <div className="max-h-64 overflow-y-auto">
            {isLoadingAgents ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <p className="text-sm text-destructive">{loadError}</p>
                <button
                  onClick={fetchAvailableAgents}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  Try again
                </button>
              </div>
            ) : filteredAgents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <CircleDashed className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? 'No matching agents' : 'No agents defined in your space'}
                </p>
              </div>
            ) : (
              <div className="py-1" ref={listRef}>
                {filteredAgents.map((agent, index) => (
                  <button
                    key={agent.slug}
                    data-index={index}
                    onClick={() => handleSelectAgent(agent)}
                    className={cn(
                      "w-full px-3 py-2 text-left transition-colors",
                      index === selectedIndex
                        ? "bg-secondary"
                        : "hover:bg-secondary/50"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {agent.title || agent.slug}
                      </span>
                      {agent.source === 'local' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                          local
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {agent.tldr}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Configure header */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center gap-2">
              <button
                onClick={handleBack}
                className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-medium text-sm">
                Summon {selectedAgent?.title || selectedAgent?.slug}
              </span>
            </div>
          </div>

          {/* Configure form */}
          <div className="p-3 space-y-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Callsign
              </label>
              <input
                ref={callsignInputRef}
                type="text"
                value={callsign}
                onChange={(e) => handleCallsignChange(e.target.value)}
                placeholder="e.g., fox"
                className={cn(
                  "w-full px-2 py-1.5 text-sm bg-background border rounded focus:outline-none focus:ring-1",
                  callsignError
                    ? "border-destructive focus:ring-destructive"
                    : "border-border focus:ring-primary"
                )}
                disabled={isSubmitting}
              />
              {callsignError && (
                <p className="text-xs text-destructive mt-1">{callsignError}</p>
              )}
            </div>

            {/* Runtime selector */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Runtime
              </label>
              <div className="relative">
                <select
                  value={selectedRuntimeId}
                  onChange={(e) => setSelectedRuntimeId(e.target.value)}
                  disabled={isSubmitting || isLoadingRuntimes}
                  className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary appearance-none pr-8"
                >
                  <option value="cloud">Miriad Cloud</option>
                  {runtimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              </div>
              {runtimes.length === 0 && !isLoadingRuntimes && (
                <p className="text-xs text-muted-foreground mt-1">
                  No local runtimes connected
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={handleBack}
                className="px-3 py-1.5 text-xs rounded hover:bg-secondary/50 text-muted-foreground"
                disabled={isSubmitting}
              >
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || !!callsignError || !callsign}
                className={cn(
                  "px-3 py-1.5 text-xs rounded font-medium flex items-center gap-1",
                  isSubmitting || callsignError || !callsign
                    ? "bg-secondary text-muted-foreground cursor-not-allowed"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                )}
              >
                {isSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                Summon
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
