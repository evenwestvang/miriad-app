import { useState, useEffect } from 'react'
import { Copy, Check, Trash2, Server, Plus, RefreshCw } from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'

interface BootstrapTokenResponse {
  bootstrapToken: string
  expiresAt: string
  connectionString: string
  command: string
}

interface LocalAgentServer {
  serverId: string
  name?: string
  connectedAt: string
  agentCount: number
  status: 'connected' | 'disconnected'
}

interface LocalAgentServersSettingsProps {
  apiHost: string
  spaceId?: string
}

export function LocalAgentServersSettings({ apiHost, spaceId: _spaceId }: LocalAgentServersSettingsProps) {
  // spaceId reserved for future multi-space support
  void _spaceId
  const [servers, setServers] = useState<LocalAgentServer[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingToken, setGeneratingToken] = useState(false)
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch active servers on mount
  useEffect(() => {
    fetchServers()
  }, [apiHost])

  async function fetchServers() {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch(`${apiHost}/api/local-agents/servers`)
      if (!response.ok) {
        throw new Error(`Failed to fetch servers: ${response.status}`)
      }
      const data = await response.json()
      setServers(data.servers || [])
    } catch (err) {
      console.error('Failed to fetch local agent servers:', err)
      // Don't show error for 404 — endpoint might not exist yet
      setServers([])
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
      setGeneratedCommand(data.command)
      setExpiresAt(data.expiresAt)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token')
    } finally {
      setGeneratingToken(false)
    }
  }

  async function revokeServer(serverId: string) {
    try {
      await apiDelete(`${apiHost}/api/local-agents/servers/${serverId}`)
      setServers(prev => prev.filter(s => s.serverId !== serverId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke server')
    }
  }

  function copyCommand() {
    if (generatedCommand) {
      navigator.clipboard.writeText(generatedCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  function formatRelativeTime(dateString: string): string {
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
        <h3 className="text-lg font-medium text-foreground">Local Agent Servers</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect a local environment to run agents on your machine.
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
          <h4 className="text-sm font-medium text-foreground">Connect New Environment</h4>
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
                Generate Command
              </>
            )}
          </button>
        </div>

        {/* Generated command display */}
        {generatedCommand && (
          <div className="space-y-2">
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
                This command expires in {formatExpiryTime(expiresAt)}. Run it in your terminal to connect.
              </p>
            )}
          </div>
        )}

        {!generatedCommand && (
          <p className="text-sm text-muted-foreground">
            Click "Generate Command" to create a one-time connection command for your local environment.
          </p>
        )}
      </div>

      {/* Active servers list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">Active Servers</h4>
          <button
            onClick={fetchServers}
            disabled={loading}
            className="p-1.5 hover:bg-secondary rounded-md transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : servers.length === 0 ? (
          <div className="p-4 border border-dashed border-border rounded-md text-center text-sm text-muted-foreground">
            No local agent servers connected.
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map(server => (
              <div
                key={server.serverId}
                className="flex items-center justify-between p-3 bg-secondary/30 border border-border rounded-md"
              >
                <div className="flex items-center gap-3">
                  <Server className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {server.name || server.serverId}
                      </span>
                      <span className={`w-2 h-2 rounded-full ${
                        server.status === 'connected' ? 'bg-green-500' : 'bg-gray-400'
                      }`} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {server.agentCount} agent{server.agentCount !== 1 ? 's' : ''} • Connected {formatRelativeTime(server.connectedAt)}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => revokeServer(server.serverId)}
                  className="p-2 hover:bg-destructive/10 rounded-md transition-colors group"
                  title="Revoke access"
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
