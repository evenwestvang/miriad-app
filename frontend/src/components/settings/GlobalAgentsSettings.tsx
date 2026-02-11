import { useState, useEffect, useCallback } from 'react'
import { Globe, Plus, Trash2, RefreshCw, AlertCircle } from 'lucide-react'
import { apiFetch, apiPut, apiDelete } from '../../lib/api'

interface GlobalAgentEntry {
  name: string
  protocol: string
  displayName?: string
  description?: string
}

interface GlobalAgentsSettingsProps {
  apiHost: string
  spaceId: string
}

export function GlobalAgentsSettings({ apiHost, spaceId }: GlobalAgentsSettingsProps) {
  const [agents, setAgents] = useState<GlobalAgentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newConnectionString, setNewConnectionString] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchAgents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch(`${apiHost}/spaces/${spaceId}/global-agents`)
      if (!response.ok) {
        throw new Error(`Failed to fetch global agents: ${response.status}`)
      }
      const data = await response.json()
      if (data.agents && typeof data.agents === 'object') {
        const agentList: GlobalAgentEntry[] = Object.entries(data.agents).map(
          ([name, config]: [string, unknown]) => ({
            name,
            protocol: (config as GlobalAgentEntry).protocol,
            displayName: (config as GlobalAgentEntry).displayName,
            description: (config as GlobalAgentEntry).description,
          })
        )
        setAgents(agentList)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch global agents')
    } finally {
      setLoading(false)
    }
  }, [apiHost, spaceId])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  async function handleAdd() {
    const trimmedName = newName.trim().toLowerCase()
    if (!trimmedName || !newConnectionString.trim()) return

    // Validate callsign format (alphanumeric + hyphens, no spaces)
    if (!/^[a-z][a-z0-9-]*$/.test(trimmedName)) {
      setAddError('Name must start with a letter and contain only lowercase letters, numbers, and hyphens')
      return
    }

    setAdding(true)
    setAddError(null)
    try {
      await apiPut(
        `${apiHost}/spaces/${spaceId}/global-agents/${trimmedName}`,
        { connectionString: newConnectionString.trim() }
      )
      // Reset form and refresh list
      setNewName('')
      setNewConnectionString('')
      setShowAddForm(false)
      await fetchAgents()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add agent')
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(name: string) {
    setDeleting(name)
    try {
      await apiDelete(`${apiHost}/spaces/${spaceId}/global-agents/${name}`)
      setConfirmDelete(null)
      await fetchAgents()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove agent')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-base text-destructive flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Header */}
      <div>
        <h3 className="text-lg font-medium text-foreground">Global Agents</h3>
        <p className="text-base text-muted-foreground mt-1">
          Global agents are available across all channels in your space. They connect via the Chorus protocol and are auto-rostered when @mentioned.
        </p>
      </div>

      {/* Agent list */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-base">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Loading...
        </div>
      ) : agents.length === 0 && !showAddForm ? (
        <div className="text-base text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
          No global agents configured. Add one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <div
              key={agent.name}
              className="flex items-center gap-3 px-3 py-2.5 bg-secondary/30 border border-border rounded-md"
            >
              <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-medium text-base text-foreground">
                  {agent.name}
                </span>
                <span className="text-xs text-muted-foreground ml-2">
                  {agent.protocol}
                </span>
              </div>
              {confirmDelete === agent.name ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Remove?</span>
                  <button
                    onClick={() => handleDelete(agent.name)}
                    disabled={deleting === agent.name}
                    className="px-2 py-1 text-xs bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {deleting === agent.name ? 'Removing...' : 'Yes'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="px-2 py-1 text-xs bg-secondary text-foreground rounded hover:bg-secondary/80"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(agent.name)}
                  className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-destructive"
                  title="Remove agent"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      {showAddForm ? (
        <div className="space-y-3 p-4 border border-border rounded-md bg-secondary/10">
          <h4 className="text-base font-medium text-foreground">Add Global Agent</h4>

          {addError && (
            <div className="p-2 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
              {addError}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-sm text-muted-foreground">
              Agent name (callsign)
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., claude, gpt-4"
              className="w-full px-3 py-2 text-base bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm text-muted-foreground">
              Connection string (Chorus URL)
            </label>
            <input
              type="password"
              value={newConnectionString}
              onChange={(e) => setNewConnectionString(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 text-base bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The connection string is stored encrypted and never shown again. To change it, remove and re-add the agent.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleAdd}
              disabled={adding || !newName.trim() || !newConnectionString.trim()}
              className="flex items-center gap-2 px-3 py-1.5 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Adding...
                </>
              ) : (
                'Add Agent'
              )}
            </button>
            <button
              onClick={() => {
                setShowAddForm(false)
                setNewName('')
                setNewConnectionString('')
                setAddError(null)
              }}
              className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" />
          Add Global Agent
        </button>
      )}
    </div>
  )
}
