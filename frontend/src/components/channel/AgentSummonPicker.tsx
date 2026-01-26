import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Loader2, Search, ChevronLeft, CircleDashed, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch, sendEventMessage } from '../../lib/api'
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
  featuredChannelStarter?: boolean
  source: 'local' | 'root'
}

interface AgentSummonPickerProps {
  /** Current roster (for callsign uniqueness validation) */
  roster: RosterAgent[]
  /** Channel ID for API calls */
  channelId: string
  /** Channel name for contextual name generation */
  channelName?: string
  /** Space ID for fetching runtimes */
  spaceId?: string
  /** API host */
  apiHost: string
  /** Called when picker is closed */
  onClose: () => void
  /** Whether picker is open */
  isOpen: boolean
  /** Pre-selected agent slug - skips browse and goes directly to configure */
  preSelectedAgentSlug?: string
}

type PickerState = 'browse' | 'configure'

// Local storage key for remembering the last used runtime (fallback)
const LAST_RUNTIME_KEY = 'cast:lastUsedRuntime'

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
 * Get fallback callsign for an agent, avoiding duplicates.
 */
function getFallbackCallsign(agent: AvailableAgent, roster: RosterAgent[]): string {
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
  channelName,
  spaceId,
  apiHost,
  onClose,
  isOpen,
  preSelectedAgentSlug,
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
  const [isGeneratingName, setIsGeneratingName] = useState(false)

  // Runtime state
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>('')
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
      // If pre-selected, we'll go to configure after agents load
      // Otherwise start in browse mode
      if (!preSelectedAgentSlug) {
        setState('browse')
      }
      setSearchQuery('')
      setSelectedIndex(0)
      setSelectedAgent(null)
      setCallsign('')
      setCallsignError(null)
      // Note: selectedRuntimeId is set by fetchRuntimes based on last used / availability
      fetchAvailableAgents()
      fetchRuntimes()
    }
  }, [isOpen, preSelectedAgentSlug])

  // Handle pre-selection after agents are loaded
  useEffect(() => {
    if (isOpen && preSelectedAgentSlug && availableAgents.length > 0 && !isLoadingAgents) {
      const preSelectedAgent = availableAgents.find(a => a.slug === preSelectedAgentSlug)
      if (preSelectedAgent) {
        handleSelectAgent(preSelectedAgent)
      } else {
        // Pre-selected agent not found, fall back to browse
        setState('browse')
      }
    }
  }, [isOpen, preSelectedAgentSlug, availableAgents, isLoadingAgents])

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

      // Priority for default runtime selection:
      // 1. Runtime of existing agents in the channel roster (sticky per-channel)
      // 2. Miriad Cloud if available
      // 3. First available runtime
      const availableIds = onlineRuntimes.map((r: RuntimeOption) => r.id)
      const miriadCloud = onlineRuntimes.find((r: RuntimeOption) => r.name === 'Miriad Cloud')

      // Check if any roster agent has a runtime that's still online
      const rosterRuntimeId = roster.find(a => a.runtimeId && availableIds.includes(a.runtimeId))?.runtimeId

      if (rosterRuntimeId) {
        // Use the same runtime as existing agents in this channel
        setSelectedRuntimeId(rosterRuntimeId)
      } else if (miriadCloud) {
        // Prefer Miriad Cloud as the default for new channels
        setSelectedRuntimeId(miriadCloud.id)
      } else if (onlineRuntimes.length > 0) {
        // Fall back to first available runtime
        setSelectedRuntimeId(onlineRuntimes[0].id)
      } else {
        // No runtimes available
        setSelectedRuntimeId('')
      }
    } catch (err) {
      console.warn('Failed to load runtimes:', err)
      setRuntimes([])
    } finally {
      setIsLoadingRuntimes(false)
    }
  }, [apiHost, spaceId, roster])

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

  // Generate a unique name based on context
  const generateName = useCallback(async (options: {
    theme?: string
    role?: string
    channelName?: string
  }): Promise<string | null> => {
    try {
      const params = new URLSearchParams()
      if (options.theme) params.set('theme', options.theme)
      if (options.role) params.set('role', options.role)
      if (options.channelName) params.set('channelName', options.channelName)

      const response = await apiFetch(
        `${apiHost}/channels/${channelId}/agents/generateName?${params.toString()}`
      )
      if (response.ok) {
        const data = await response.json()
        return data.name || null
      }
    } catch (err) {
      console.warn('Failed to generate name:', err)
    }
    return null
  }, [apiHost, channelId])

  // Select an agent and go to configure state
  const handleSelectAgent = async (agent: AvailableAgent) => {
    setSelectedAgent(agent)
    setState('configure')

    // Always generate a unique name (backend defaults if no context provided)
    setIsGeneratingName(true)
    setCallsign('') // Clear while loading
    setCallsignError(null)

    const generatedName = await generateName({
      theme: agent.nameTheme,
      role: agent.slug,
      channelName,
    })
    if (generatedName) {
      setCallsign(generatedName)
      setCallsignError(validateCallsign(generatedName))
    } else {
      // Fall back to default names if generation fails
      const fallback = getFallbackCallsign(agent, roster)
      setCallsign(fallback)
      setCallsignError(validateCallsign(fallback))
    }
    setIsGeneratingName(false)
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
      // Build request body with required runtimeId
      const requestBody: Record<string, string> = {
        agentType: selectedAgent.slug,
        callsign,
        runtimeId: selectedRuntimeId,
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

      // Check if this is the first agent in the channel
      const isFirstAgent = roster.filter(r => r.agentType).length === 0

      // Success - close picker (roster will update via WebSocket event)
      onClose()

      // If first agent, send a nudge after a short delay
      if (isFirstAgent) {
        setTimeout(() => {
          sendEventMessage(
            channelId,
            `@${callsign} The user is not seeing this message, this is the system giving you a nudge: You are the first agent in this channel. Greet the user and get things kicked off according to your role.`
          ).catch(err => {
            console.error('Failed to send first-agent nudge:', err)
          })
        }, 300)
      }
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
                className="w-full pl-8 pr-8 py-1.5 text-base bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
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
                <p className="text-base text-destructive">{loadError}</p>
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
                <p className="text-base text-muted-foreground">
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
                      <span className="font-medium text-base">
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
              <span className="font-medium text-base">
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
              <div className="relative flex items-center">
                <input
                  ref={callsignInputRef}
                  type="text"
                  value={callsign}
                  onChange={(e) => handleCallsignChange(e.target.value)}
                  placeholder={isGeneratingName ? "Generating..." : "e.g., fox"}
                  className={cn(
                    "w-full px-2 py-1.5 text-base bg-background border rounded focus:outline-none focus:ring-1",
                    isGeneratingName && "pr-8",
                    callsignError
                      ? "border-destructive focus:ring-destructive"
                      : "border-border focus:ring-primary"
                  )}
                  disabled={isSubmitting || isGeneratingName}
                />
                {isGeneratingName && (
                  <Loader2 className="absolute right-2 w-4 h-4 animate-spin text-muted-foreground" />
                )}
              </div>
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
                  className="w-full px-2 py-1.5 text-base bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary appearance-none pr-8"
                >
                  {runtimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              </div>
              {runtimes.length === 0 && !isLoadingRuntimes && (
                <p className="text-xs text-destructive mt-1">
                  No runtimes online. Start Miriad Cloud or connect a local runtime.
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
                disabled={isSubmitting || isGeneratingName || !!callsignError || !callsign || !selectedRuntimeId}
                className={cn(
                  "px-3 py-1.5 text-xs rounded font-medium flex items-center gap-1",
                  isSubmitting || isGeneratingName || callsignError || !callsign || !selectedRuntimeId
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
