import { useState, useEffect } from 'react'
import { Copy, Check, Trash2, Monitor, Plus, RefreshCw } from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'

interface BootstrapTokenResponse {
  bootstrapToken: string
  expiresAt: string
  connectionString: string
  command: string
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

  // Fetch runtimes on mount
  useEffect(() => {
    fetchRuntimes()
  }, [apiHost, spaceId])

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
        `${apiHost}/api/local-agents/bootstrap-token`,
        {}
      )
      // Update command to use new package name
      const command = data.command.replace(
        '@anthropic/cast-local-agent init',
        'npx @caststack/local-runtime auth'
      )
      setGeneratedCommand(command)
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-foreground">Local Runtimes</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect local machines to run agents on your own hardware.
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

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
            {runtimes.map(runtime => (
              <div
                key={runtime.id}
                className="flex items-center justify-between p-3 bg-secondary/30 border border-border rounded-md"
              >
                <div className="flex items-center gap-3">
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
                      {runtime.agentCount} agent{runtime.agentCount !== 1 ? 's' : ''}
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
