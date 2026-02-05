import { useState, useRef, useEffect } from 'react'
import { Monitor, RefreshCw, ChevronDown, ChevronRight, Bot, Cloud, Play, Settings, Square, Trash2 } from 'lucide-react'
import { apiFetch, apiPost, apiJson, apiDelete } from '../lib/api'

// Runtime is considered stale if no heartbeat in this many milliseconds
const STALE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes

const ANTHROPIC_API_KEY = 'anthropic_api_key'

interface Runtime {
  id: string
  name: string
  type: 'local' | 'docker' | 'fly'
  status: 'online' | 'offline'
  machineInfo?: {
    os: string
    hostname: string
  } | null
  lastSeenAt: string | null
  agentCount: number
}

/**
 * Derived state for Miriad Cloud - computed from reality, not tracked.
 * Matches backend MiriadCloudState type.
 */
type MiriadCloudState = 'stopped' | 'starting' | 'connecting' | 'online' | 'stopping' | 'error'

interface MiriadCloudStatus {
  state: MiriadCloudState
  canStart: boolean
  canStop: boolean
  runtime: {
    id: string
    name: string
    lastSeenAt: string | null
  } | null
  provider: 'docker' | 'fly'
}

interface RuntimeAgent {
  id: string
  callsign: string
  agentType: string
  status: string
  channelId: string
  channelName: string
}

interface SecretMetadata {
  setAt: string
  expiresAt?: string
}

interface SecretsListResponse {
  secrets: Record<string, SecretMetadata>
}

type SettingsSection = 'cloud' | 'runtimes'

interface RuntimeStatusDropdownProps {
  apiHost: string
  spaceId: string
  onOpenSettings?: (section?: SettingsSection) => void
  /** When true, settings modal is open - used to refresh state when it closes */
  settingsOpen?: boolean
  /** Called when any runtime status changes (triggers roster reload) */
  onRuntimeStatusChange?: () => void
  /** Called when the disconnected state changes (no runtime online AND no API key) */
  onDisconnectedStateChange?: (isDisconnected: boolean) => void
  /** Counter that increments when an agent_state frame is received - triggers fast polling */
  agentStateEventCounter?: number
}

// Temporary hack: identify Miriad Cloud by name
function isMiriadCloud(runtime: Runtime): boolean {
  return runtime.name === 'Miriad Cloud'
}

// Check if runtime is stale (no heartbeat in STALE_TIMEOUT_MS)
function isRuntimeStale(runtime: Runtime): boolean {
  if (!runtime.lastSeenAt) return true
  const lastSeen = new Date(runtime.lastSeenAt).getTime()
  const now = Date.now()
  return now - lastSeen > STALE_TIMEOUT_MS
}

export function RuntimeStatusDropdown({ apiHost, spaceId, onOpenSettings, settingsOpen, onRuntimeStatusChange, onDisconnectedStateChange, agentStateEventCounter }: RuntimeStatusDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(new Set())
  const [runtimeAgents, setRuntimeAgents] = useState<Record<string, RuntimeAgent[]>>({})
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set())
  const [cloudStatus, setCloudStatus] = useState<MiriadCloudStatus | null>(null)
  const [loadingCloudStatus, setLoadingCloudStatus] = useState(false)
  const [deletingRuntime, setDeletingRuntime] = useState<string | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [hasCheckedRuntimes, setHasCheckedRuntimes] = useState(false)
  // Fast polling: poll every 1s for 10s after agent_state event, then back to normal 30s
  const [fastPollUntil, setFastPollUntil] = useState<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Track previous runtime statuses to detect changes
  const prevRuntimeStatusesRef = useRef<Map<string, 'online' | 'offline'>>(new Map())

  // Determine overall status (computed early so it can be used in effects)
  // A runtime is considered "effectively online" if status is online AND not stale
  // For Miriad Cloud, use the derived state from cloudStatus
  const onlineRuntimes = runtimes.filter(r => {
    if (isMiriadCloud(r)) {
      return cloudStatus?.state === 'online'
    }
    return r.status === 'online' && !isRuntimeStale(r)
  })
  const hasAnyOnline = onlineRuntimes.length > 0
  const totalOnline = onlineRuntimes.length
  
  // Miriad Cloud is "busy" if it's in a transitional state
  const isCloudBusy = cloudStatus?.state === 'starting' || cloudStatus?.state === 'connecting' || cloudStatus?.state === 'stopping'

  // Check if API key is configured (re-check when dropdown opens or settings closes)
  useEffect(() => {
    async function checkApiKey() {
      try {
        const data = await apiJson<SecretsListResponse>(
          `${apiHost}/api/spaces/${spaceId}/secrets`
        )
        setHasApiKey(ANTHROPIC_API_KEY in data.secrets)
      } catch (err) {
        console.error('Failed to check API key:', err)
        setHasApiKey(false)
      }
    }
    // Check when dropdown is open and settings modal is not covering it
    if (isOpen && !settingsOpen) {
      checkApiKey()
    }
  }, [apiHost, spaceId, isOpen, settingsOpen])

  // Trigger fast polling mode when agent_state event is received
  useEffect(() => {
    if (agentStateEventCounter !== undefined && agentStateEventCounter > 0) {
      // Enable fast polling for 10 seconds
      setFastPollUntil(Date.now() + 10000)
      // Immediately fetch to get fresh state
      fetchRuntimes()
    }
  }, [agentStateEventCounter])

  // Determine current poll interval
  // Priority: cloudBusy (2s) > fastPoll (1s) > normal (30s)
  const isInFastPollMode = fastPollUntil !== null && Date.now() < fastPollUntil
  const pollInterval = isCloudBusy ? 2000 : isInFastPollMode ? 1000 : 30000

  // Fetch status on mount and periodically
  useEffect(() => {
    fetchRuntimes()
    const interval = setInterval(() => {
      fetchRuntimes()
      // Check if fast poll mode has expired
      if (fastPollUntil !== null && Date.now() >= fastPollUntil) {
        setFastPollUntil(null)
      }
    }, pollInterval)
    return () => clearInterval(interval)
  }, [apiHost, spaceId, pollInterval])

  // Close on outside click (but not when no runtimes are online)
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        // Don't close if no runtimes are online - user needs to configure one
        if (hasAnyOnline) {
          setIsOpen(false)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, hasAnyOnline])

  // Close on escape (but not when no runtimes are online)
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      // Don't close if no runtimes are online - user needs to configure one
      if (e.key === 'Escape' && hasAnyOnline) {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, hasAnyOnline])

  // Auto-open dropdown if no runtimes are online after initial check
  useEffect(() => {
    if (hasCheckedRuntimes && !hasAnyOnline && !isOpen) {
      setIsOpen(true)
    }
  }, [hasCheckedRuntimes, hasAnyOnline])

  // Notify parent of disconnected state (no runtime online AND no API key)
  useEffect(() => {
    if (onDisconnectedStateChange && hasCheckedRuntimes && hasApiKey !== null) {
      const isDisconnected = !hasAnyOnline && !hasApiKey
      onDisconnectedStateChange(isDisconnected)
    }
  }, [hasCheckedRuntimes, hasAnyOnline, hasApiKey, onDisconnectedStateChange])

  async function fetchCloudStatus() {
    setLoadingCloudStatus(true)
    try {
      const response = await apiFetch(`${apiHost}/api/runtimes/miriad-cloud/status`)
      if (response.ok) {
        const data = await response.json()
        setCloudStatus(data as MiriadCloudStatus)
      }
    } catch (err) {
      console.error('Failed to fetch Miriad Cloud status:', err)
    } finally {
      setLoadingCloudStatus(false)
    }
  }

  async function fetchRuntimes() {
    setLoading(true)
    try {
      // Fetch both runtimes list and cloud status in parallel
      const [runtimesResponse] = await Promise.all([
        apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes`),
        fetchCloudStatus(),
      ])
      
      if (runtimesResponse.ok) {
        const data = await runtimesResponse.json()
        const newRuntimes: Runtime[] = data.runtimes || []
        setRuntimes(newRuntimes)

        // Check if any runtime status changed
        let statusChanged = false
        const newStatusMap = new Map<string, 'online' | 'offline'>()
        for (const rt of newRuntimes) {
          newStatusMap.set(rt.id, rt.status)
          const prevStatus = prevRuntimeStatusesRef.current.get(rt.id)
          if (prevStatus !== undefined && prevStatus !== rt.status) {
            statusChanged = true
          }
        }
        // Also check for runtimes that disappeared
        for (const [id] of prevRuntimeStatusesRef.current) {
          if (!newStatusMap.has(id)) {
            statusChanged = true
          }
        }
        prevRuntimeStatusesRef.current = newStatusMap

        // Notify parent if status changed (triggers roster reload)
        if (statusChanged && onRuntimeStatusChange) {
          onRuntimeStatusChange()
        }
      }
    } catch (err) {
      console.error('Failed to fetch runtime status:', err)
    } finally {
      setLoading(false)
      setHasCheckedRuntimes(true)
    }
  }

  async function startMiriadCloud() {
    try {
      await apiPost(`${apiHost}/api/runtimes/miriad-cloud/start`, {})
      // Immediately fetch status - it will show 'starting' state
      await fetchRuntimes()
    } catch (err) {
      console.error('Failed to start Miriad Cloud:', err)
    }
  }

  async function stopMiriadCloud() {
    try {
      await apiPost(`${apiHost}/api/runtimes/miriad-cloud/stop`, {})
      // Immediately fetch status - it will show 'stopping' state
      await fetchRuntimes()
    } catch (err) {
      console.error('Failed to stop Miriad Cloud:', err)
    }
  }

  async function deleteRuntime(runtimeId: string) {
    setDeletingRuntime(runtimeId)
    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/runtimes/${runtimeId}`)
      await fetchRuntimes()
    } catch (err) {
      console.error('Failed to delete runtime:', err)
    } finally {
      setDeletingRuntime(null)
    }
  }

  async function fetchRuntimeAgents(runtimeId: string) {
    setLoadingAgents(prev => new Set(prev).add(runtimeId))
    try {
      const response = await apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes/${runtimeId}/agents`)
      if (response.ok) {
        const data = await response.json()
        setRuntimeAgents(prev => ({ ...prev, [runtimeId]: data.agents || [] }))
      }
    } catch (err) {
      console.error('Failed to fetch runtime agents:', err)
      setRuntimeAgents(prev => ({ ...prev, [runtimeId]: [] }))
    } finally {
      setLoadingAgents(prev => {
        const newSet = new Set(prev)
        newSet.delete(runtimeId)
        return newSet
      })
    }
  }

  function toggleRuntimeExpanded(runtimeId: string) {
    const newExpanded = new Set(expandedRuntimes)
    if (newExpanded.has(runtimeId)) {
      newExpanded.delete(runtimeId)
    } else {
      newExpanded.add(runtimeId)
      if (!runtimeAgents[runtimeId]) {
        fetchRuntimeAgents(runtimeId)
      }
    }
    setExpandedRuntimes(newExpanded)
  }

  function formatRelativeTime(dateString: string | null): string {
    if (!dateString) return 'never'
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  // Check if Miriad Cloud is in the list
  const miriadCloudRuntime = runtimes.find(isMiriadCloud)
  const hasMiriadCloudRecord = !!miriadCloudRuntime

  return (
    <div ref={menuRef} className="relative">
      {/* Status indicator button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1 hover:bg-[var(--cast-bg-hover)] rounded transition-colors"
        title={hasAnyOnline ? `${totalOnline} runtime${totalOnline !== 1 ? 's' : ''} online` : 'No runtimes online'}
      >
        <span
          className={`w-2 h-2 rounded-full ${
            hasAnyOnline ? 'bg-green-500' : 'bg-gray-400'
          }`}
        />
        <span className="text-xs text-muted-foreground">
          {hasAnyOnline ? `${totalOnline} online` : 'Offline'}
        </span>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/20">
            <span className="text-base font-medium">Runtimes</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                fetchRuntimes()
              }}
              disabled={loading}
              className="p-1 hover:bg-secondary rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Warning when no runtimes online */}
          {!hasAnyOnline && (
            <div className="px-3 py-2 bg-orange-500/10 border-b border-orange-500/20">
              <p className="text-xs text-orange-600 dark:text-orange-400">
                You need at least one runtime to work with agents. Start Miriad Cloud or connect a local runtime.
              </p>
            </div>
          )}

          <div className="max-h-80 overflow-y-auto">
            {/* Bootstrap Miriad Cloud - only show when there's no record at all */}
            {!hasMiriadCloudRecord && (
              <div className="p-3 border-b border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cloud className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <div className="text-base font-medium">Miriad Cloud</div>
                      <div className="text-xs text-muted-foreground">
                        {hasApiKey === false ? 'Not configured' : cloudStatus?.state === 'starting' ? 'Starting...' : 'Not running'}
                      </div>
                    </div>
                  </div>
                  {hasApiKey === false ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenSettings?.('cloud')
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
                    >
                      <Settings className="w-3 h-3" />
                      Configure
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        startMiriadCloud()
                      }}
                      disabled={!cloudStatus?.canStart}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                    >
                      {cloudStatus?.state === 'starting' ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Play className="w-3 h-3" />
                      )}
                      Start
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Runtime list */}
            {runtimes.length === 0 && hasMiriadCloudRecord ? (
              <div className="p-4 text-center text-base text-muted-foreground">
                No runtimes connected
              </div>
            ) : runtimes.length > 0 ? (
              <div>
                {runtimes.map(runtime => {
                  const isExpanded = expandedRuntimes.has(runtime.id)
                  const agents = runtimeAgents[runtime.id] || []
                  const isLoadingAgents = loadingAgents.has(runtime.id)
                  const isCloud = isMiriadCloud(runtime)
                  const isStale = isRuntimeStale(runtime)
                  
                  // For Miriad Cloud, use derived state from cloudStatus
                  // For other runtimes, use the old staleness check
                  const cloudState = isCloud ? cloudStatus?.state : null
                  const isEffectivelyOnline = isCloud 
                    ? cloudState === 'online'
                    : runtime.status === 'online' && !isStale
                  
                  // Get status label for Miriad Cloud
                  const getCloudStatusLabel = () => {
                    switch (cloudState) {
                      case 'online': return formatRelativeTime(cloudStatus?.runtime?.lastSeenAt ?? null)
                      case 'starting': return 'Starting...'
                      case 'connecting': return 'Connecting...'
                      case 'stopping': return 'Stopping...'
                      case 'stopped': return 'Stopped'
                      case 'error': return 'Error'
                      default: return 'Unknown'
                    }
                  }

                  return (
                    <div key={runtime.id} className="border-b border-border last:border-b-0">
                      <div className="flex items-center gap-2 p-3">
                        <button
                          onClick={() => runtime.agentCount > 0 && toggleRuntimeExpanded(runtime.id)}
                          className="p-0.5 hover:bg-secondary rounded transition-colors"
                          disabled={runtime.agentCount === 0}
                        >
                          {runtime.agentCount === 0 ? (
                            <div className="w-4 h-4" />
                          ) : isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                        </button>
                        {isCloud ? (
                          <Cloud className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Monitor className="w-4 h-4 text-muted-foreground" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-base font-medium truncate">{runtime.name}</span>
                            {/* Status indicator - yellow for transitional states */}
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              isEffectivelyOnline 
                                ? 'bg-green-500' 
                                : (isCloud && (cloudState === 'starting' || cloudState === 'connecting'))
                                  ? 'bg-yellow-500 animate-pulse'
                                  : 'bg-gray-400'
                            }`} />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {runtime.agentCount} agent{runtime.agentCount !== 1 ? 's' : ''}
                            {' • '}
                            {isCloud 
                              ? getCloudStatusLabel()
                              : isEffectivelyOnline
                                ? formatRelativeTime(runtime.lastSeenAt)
                                : isStale && runtime.status === 'online'
                                  ? 'Stale'
                                  : 'Offline'}
                          </div>
                        </div>
                        {/* Stop button for Miriad Cloud when canStop is true */}
                        {isCloud && cloudStatus?.canStop && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              stopMiriadCloud()
                            }}
                            disabled={cloudState === 'stopping'}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 disabled:opacity-50"
                          >
                            {cloudState === 'stopping' ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <Square className="w-3 h-3" />
                            )}
                            Stop
                          </button>
                        )}
                        {/* Start/Configure button for Miriad Cloud when canStart is true */}
                        {isCloud && cloudStatus?.canStart && (
                          hasApiKey === false ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenSettings?.('cloud')
                              }}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
                            >
                              <Settings className="w-3 h-3" />
                              Configure
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                startMiriadCloud()
                              }}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                            >
                              <Play className="w-3 h-3" />
                              Start
                            </button>
                          )
                        )}
                        {/* Delete button for stale non-Miriad Cloud runtimes */}
                        {!isCloud && isStale && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteRuntime(runtime.id)
                            }}
                            disabled={deletingRuntime === runtime.id}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 rounded disabled:opacity-50"
                            title="Remove stale runtime"
                          >
                            {deletingRuntime === runtime.id ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <Trash2 className="w-3 h-3" />
                            )}
                          </button>
                        )}
                      </div>

                      {/* Expanded agent list */}
                      {isExpanded && (
                        <div className="bg-secondary/20 px-3 py-2 border-t border-border">
                          {isLoadingAgents ? (
                            <div className="text-xs text-muted-foreground py-1">Loading...</div>
                          ) : agents.length === 0 ? (
                            <div className="text-xs text-muted-foreground py-1">No agents</div>
                          ) : (
                            <div className="space-y-1">
                              {agents.map(agent => (
                                <div
                                  key={agent.id}
                                  className="flex items-center gap-2 py-1 text-xs"
                                >
                                  <Bot className="w-3 h-3 text-muted-foreground" />
                                  <span className="font-medium">@{agent.callsign}</span>
                                  <span className="text-muted-foreground truncate">#{agent.channelName}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}

            {/* Link to local runtimes settings */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onOpenSettings?.('runtimes')
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground hover:bg-secondary/50 border-t border-border transition-colors"
            >
              <Monitor className="w-3.5 h-3.5" />
              Run agents on your own systems
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
