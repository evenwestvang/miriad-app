import { useState, useEffect } from 'react'
import { Copy, Check, Trash2, Monitor, Plus, RefreshCw, ChevronDown, ChevronRight, Bot, Cloud, Play, Square } from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'

interface BootstrapTokenResponse {
  bootstrapToken: string
  expiresAt: string
  connectionString: string
  command: string
}

interface MiriadCloudStatus {
  available: boolean
  runtime: {
    id: string
    name: string
    status: 'online' | 'offline'
    lastSeenAt: string | null
  } | null
  container: {
    status: 'running' | 'stopped' | 'not_found'
    provider: 'docker' | 'fly'
  }
}

export interface Runtime {
  id: string
  name: string
  type: 'local' | 'docker' | 'fly'
  status: 'online' | 'offline'
  machineInfo?: {
    os: string
    hostname: string
  } | null
  lastSeenAt: string | null
  createdAt: string
  agentCount: number
}

interface RuntimeAgent {
  id: string
  callsign: string
  agentType: string
  status: string
  channelId: string
  channelName: string
  lastHeartbeat: string | null
}

interface RuntimesSettingsProps {
  apiHost: string
  spaceId: string
}

export function RuntimesSettings({ apiHost, spaceId }: RuntimesSettingsProps) {
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingToken, setGeneratingToken] = useState(false)
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRuntimes, setExpandedRuntimes] = useState<Set<string>>(new Set())
  const [runtimeAgents, setRuntimeAgents] = useState<Record<string, RuntimeAgent[]>>({})
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set())

  // Miriad Cloud state
  const [cloudStatus, setCloudStatus] = useState<MiriadCloudStatus | null>(null)
  const [cloudLoading, setCloudLoading] = useState(true)
  const [cloudStarting, setCloudStarting] = useState(false)
  const [cloudStopping, setCloudStopping] = useState(false)

  // Fetch runtimes and cloud status on mount
  useEffect(() => {
    fetchRuntimes()
    fetchCloudStatus()
  }, [apiHost, spaceId])

  async function fetchCloudStatus() {
    setCloudLoading(true)
    try {
      const response = await apiFetch(`${apiHost}/api/runtimes/miriad-cloud/status`)
      if (response.ok) {
        const data = await response.json()
        setCloudStatus(data)
      }
    } catch (err) {
      console.error('Failed to fetch Miriad Cloud status:', err)
    } finally {
      setCloudLoading(false)
    }
  }

  async function startMiriadCloud() {
    setCloudStarting(true)
    setError(null)
    try {
      await apiPost<{ status: string; runtime: { id: string; name: string; status: string } }>(
        `${apiHost}/api/runtimes/miriad-cloud/start`,
        {}
      )
      // Refresh status after starting
      await fetchCloudStatus()
      await fetchRuntimes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Miriad Cloud')
    } finally {
      setCloudStarting(false)
    }
  }

  async function stopMiriadCloud() {
    setCloudStopping(true)
    setError(null)
    try {
      await apiPost(`${apiHost}/api/runtimes/miriad-cloud/stop`, {})
      // Refresh status after stopping
      await fetchCloudStatus()
      await fetchRuntimes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop Miriad Cloud')
    } finally {
      setCloudStopping(false)
    }
  }

  async function fetchRuntimes() {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes`)
      if (!response.ok) {
        throw new Error(`Failed to fetch runtimes: ${response.status}`)
      }
      const data = await response.json()
      setRuntimes(data.runtimes || [])
    } catch (err) {
      console.error('Failed to fetch runtimes:', err)
      setRuntimes([])
    } finally {
      setLoading(false)
    }
  }

  async function generateBootstrapToken() {
    setGeneratingToken(true)
    setError(null)
    setGeneratedCommand(null)
    try {
      const data = await apiPost<BootstrapTokenResponse>(
        `${apiHost}/api/runtimes/auth/bootstrap-token`,
        {}
      )
      setGeneratedCommand(data.command)
      setExpiresAt(data.expiresAt)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token')
    } finally {
      setGeneratingToken(false)
    }
  }

  async function deleteRuntime(runtimeId: string) {
    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/runtimes/${runtimeId}`)
      setRuntimes(prev => prev.filter(r => r.id !== runtimeId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete runtime')
    }
  }

  async function toggleRuntimeExpanded(runtimeId: string) {
    const newExpanded = new Set(expandedRuntimes)
    if (newExpanded.has(runtimeId)) {
      newExpanded.delete(runtimeId)
      setExpandedRuntimes(newExpanded)
    } else {
      newExpanded.add(runtimeId)
      setExpandedRuntimes(newExpanded)
      // Fetch agents if not already loaded
      if (!runtimeAgents[runtimeId]) {
        await fetchRuntimeAgents(runtimeId)
      }
    }
  }

  async function fetchRuntimeAgents(runtimeId: string) {
    setLoadingAgents(prev => new Set(prev).add(runtimeId))
    try {
      const response = await apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes/${runtimeId}/agents`)
      if (!response.ok) {
        throw new Error(`Failed to fetch agents: ${response.status}`)
      }
      const data = await response.json()
      setRuntimeAgents(prev => ({ ...prev, [runtimeId]: data.agents || [] }))
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

  function copyCommand() {
    if (generatedCommand) {
      navigator.clipboard.writeText(generatedCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
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

  function formatExpiryTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = date.getTime() - now.getTime()
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins <= 0) return 'expired'
    if (diffMins < 60) return `${diffMins} minutes`
    return `${Math.floor(diffMins / 60)} hours`
  }

  // Determine cloud status for display
  const isCloudOnline = cloudStatus?.runtime?.status === 'online'
  const isCloudStarting = cloudStarting || (cloudStatus?.container?.status === 'running' && !isCloudOnline)

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Miriad Cloud Section */}
      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-medium text-foreground">Miriad Cloud</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Run agents in a managed cloud environment.
          </p>
        </div>

        <div className="p-4 bg-secondary/30 border border-border rounded-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Cloud className="w-5 h-5 text-muted-foreground" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">Miriad Cloud</span>
                  {cloudLoading ? (
                    <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />
                  ) : (
                    <span className={`w-2 h-2 rounded-full ${
                      isCloudOnline ? 'bg-green-500' :
                      isCloudStarting ? 'bg-yellow-500 animate-pulse' :
                      'bg-gray-400'
                    }`} />
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {cloudLoading ? 'Checking status...' :
                   isCloudOnline ? 'Connected and ready' :
                   isCloudStarting ? 'Starting up...' :
                   'Not running'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!cloudLoading && !isCloudOnline && (
                <button
                  onClick={startMiriadCloud}
                  disabled={cloudStarting}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cloudStarting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Start
                    </>
                  )}
                </button>
              )}
              {!cloudLoading && isCloudOnline && (
                <button
                  onClick={stopMiriadCloud}
                  disabled={cloudStopping}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cloudStopping ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Stopping...
                    </>
                  ) : (
                    <>
                      <Square className="w-4 h-4" />
                      Stop
                    </>
                  )}
                </button>
              )}
              <button
                onClick={fetchCloudStatus}
                disabled={cloudLoading}
                className="p-1.5 hover:bg-secondary rounded-md transition-colors"
                title="Refresh status"
              >
                <RefreshCw className={`w-4 h-4 text-muted-foreground ${cloudLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Local Runtimes Section */}
      <div>
        <h3 className="text-lg font-medium text-foreground">Local Runtimes</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect local machines to run agents on your own hardware.
        </p>
      </div>

      {/* Generate connection command section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">Connect New Runtime</h4>
          <button
            onClick={generateBootstrapToken}
            disabled={generatingToken}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generatingToken ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Connect Local Runtime
              </>
            )}
          </button>
        </div>

        {/* Generated command display */}
        {generatedCommand && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Run this command on your machine:
            </p>
            <div className="relative">
              <div className="p-3 pr-12 bg-secondary/50 border border-border rounded-md font-mono text-sm break-all">
                {generatedCommand}
              </div>
              <button
                onClick={copyCommand}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-md transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </div>
            {expiresAt && (
              <p className="text-xs text-muted-foreground">
                This command expires in {formatExpiryTime(expiresAt)}. Once connected, your runtime will appear below.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Runtimes list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">Active Runtimes</h4>
          <button
            onClick={fetchRuntimes}
            disabled={loading}
            className="p-1.5 hover:bg-secondary rounded-md transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : runtimes.length === 0 ? (
          <div className="p-4 border border-dashed border-border rounded-md text-center text-sm text-muted-foreground">
            No local runtimes connected.
          </div>
        ) : (
          <div className="space-y-2">
            {runtimes.map(runtime => {
              const isExpanded = expandedRuntimes.has(runtime.id)
              const agents = runtimeAgents[runtime.id] || []
              const isLoadingAgents = loadingAgents.has(runtime.id)

              return (
                <div
                  key={runtime.id}
                  className="bg-secondary/30 border border-border rounded-md overflow-hidden"
                >
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggleRuntimeExpanded(runtime.id)}
                        className="p-1 hover:bg-secondary rounded transition-colors"
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
                      <Monitor className="w-5 h-5 text-muted-foreground" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            {runtime.name}
                          </span>
                          <span className={`w-2 h-2 rounded-full ${
                            runtime.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                          }`} />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {runtime.machineInfo?.os || 'unknown'}
                          {' • '}
                          <button
                            onClick={() => runtime.agentCount > 0 && toggleRuntimeExpanded(runtime.id)}
                            className={runtime.agentCount > 0 ? 'hover:underline cursor-pointer' : ''}
                          >
                            {runtime.agentCount} agent{runtime.agentCount !== 1 ? 's' : ''}
                          </button>
                          {' • '}
                          {runtime.status === 'online'
                            ? `Last seen ${formatRelativeTime(runtime.lastSeenAt)}`
                            : 'Offline'
                          }
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => deleteRuntime(runtime.id)}
                      className="p-2 hover:bg-destructive/10 rounded-md transition-colors group"
                      title="Delete runtime"
                    >
                      <Trash2 className="w-4 h-4 text-muted-foreground group-hover:text-destructive" />
                    </button>
                  </div>

                  {/* Expanded agent list */}
                  {isExpanded && (
                    <div className="border-t border-border bg-secondary/20 px-3 py-2">
                      {isLoadingAgents ? (
                        <div className="text-xs text-muted-foreground py-2">Loading agents...</div>
                      ) : agents.length === 0 ? (
                        <div className="text-xs text-muted-foreground py-2">No agents found</div>
                      ) : (
                        <div className="space-y-1">
                          {agents.map(agent => (
                            <div
                              key={agent.id}
                              className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-secondary/50"
                            >
                              <Bot className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-sm font-medium">@{agent.callsign}</span>
                              <span className="text-xs text-muted-foreground">in #{agent.channelName}</span>
                              <span className={`ml-auto w-1.5 h-1.5 rounded-full ${
                                agent.status === 'online' || agent.status === 'active' ? 'bg-green-500' : 'bg-gray-400'
                              }`} />
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
        )}
      </div>
    </div>
  )
}
