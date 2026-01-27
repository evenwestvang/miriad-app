import { useState, useEffect } from 'react'
import { Plus, X, Server } from 'lucide-react'
import { EditableField } from '../ui/editable-field'
import { apiFetch } from '../../lib/api'
import { cn } from '../../lib/utils'

// Agent props types - matches server schema
// Note: engine and model are handled by backend defaults, not exposed in UI
// Note: agentName is handled at spawn time (callsign), not in the definition
export interface AgentProps {
  engine?: string
  model?: string
  nameTheme?: string
  mcp?: McpReference[]
  featuredChannelStarter?: boolean
}

interface McpReference {
  slug: string
  channel?: string // If from different channel (e.g., 'root')
}

interface AgentPropsEditorProps {
  props: AgentProps
  onChange: (updates: Partial<AgentProps>) => void
  channelId: string
  apiHost: string
}

// Available MCP artifact from API
interface McpArtifact {
  slug: string
  title?: string
  tldr: string
  channel: string
}

export function AgentPropsEditor({ props, onChange, channelId, apiHost }: AgentPropsEditorProps) {
  const [availableMcps, setAvailableMcps] = useState<McpArtifact[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [showMcpPicker, setShowMcpPicker] = useState(false)

  // Fetch available MCPs from current channel and root
  useEffect(() => {
    async function fetchMcps() {
      setMcpLoading(true)
      try {
        // Fetch from current channel
        const channelResponse = await apiFetch(
          `${apiHost}/channels/${channelId}/artifacts?type=system.mcp`
        )
        const channelData = channelResponse.ok ? await channelResponse.json() : { artifacts: [] }
        const channelMcps: McpArtifact[] = (channelData.artifacts || []).map((a: McpArtifact) => ({
          ...a,
          channel: channelId,
        }))

        // Fetch from root (if different)
        let rootMcps: McpArtifact[] = []
        if (channelId !== 'root') {
          const rootResponse = await apiFetch(`${apiHost}/channels/root/artifacts?type=system.mcp`)
          const rootData = rootResponse.ok ? await rootResponse.json() : { artifacts: [] }
          rootMcps = (rootData.artifacts || []).map((a: McpArtifact) => ({
            ...a,
            channel: 'root',
          }))
        }

        setAvailableMcps([...channelMcps, ...rootMcps])
      } catch (error) {
        console.error('Failed to fetch MCPs:', error)
      } finally {
        setMcpLoading(false)
      }
    }

    fetchMcps()
  }, [channelId, apiHost])

  // Add MCP to the list (keeps picker open for multi-select)
  const addMcp = (mcp: McpArtifact) => {
    const currentMcps = props.mcp || []
    // Check if already added
    const exists = currentMcps.some(
      (m) => m.slug === mcp.slug && (m.channel || channelId) === mcp.channel
    )
    if (!exists) {
      const newRef: McpReference = { slug: mcp.slug }
      if (mcp.channel !== channelId) {
        newRef.channel = mcp.channel
      }
      onChange({ mcp: [...currentMcps, newRef] })
    }
    // Don't close picker - let user add multiple MCPs
  }

  // Remove MCP from the list
  const removeMcp = (index: number) => {
    const currentMcps = props.mcp || []
    onChange({ mcp: currentMcps.filter((_, i) => i !== index) })
  }

  // Get display name for an MCP reference
  const getMcpDisplay = (ref: McpReference) => {
    const mcp = availableMcps.find(
      (m) => m.slug === ref.slug && m.channel === (ref.channel || channelId)
    )
    const displayName = mcp?.title || ref.slug
    return ref.channel && ref.channel !== channelId ? `${displayName} (#${ref.channel})` : displayName
  }

  // Filter available MCPs to exclude already selected ones
  const selectableMcps = availableMcps.filter((mcp) => {
    const currentMcps = props.mcp || []
    return !currentMcps.some(
      (m) => m.slug === mcp.slug && (m.channel || channelId) === mcp.channel
    )
  })

  return (
    <div className="space-y-8">
      {/* Engine Selection */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          Engine
        </label>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onChange({ engine: 'claude-sdk' })}
            className={cn(
              "px-3 py-1.5 text-base rounded-l border transition-colors",
              props.engine !== 'nuum'
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary text-foreground border-border hover:bg-secondary/80"
            )}
          >
            Claude
          </button>
          <button
            type="button"
            onClick={() => onChange({ engine: 'nuum' })}
            className={cn(
              "px-3 py-1.5 text-base rounded-r border transition-colors",
              props.engine === 'nuum'
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary text-foreground border-border hover:bg-secondary/80"
            )}
          >
            Nuum*
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          *) Nuum is an experimental agent engine.{' '}
          <a 
            href="https://github.com/miriad-systems/nuum" 
            target="_blank" 
            rel="noopener noreferrer"
            className="underline hover:text-foreground transition-colors"
          >
            Read more
          </a>
        </p>
      </div>

      {/* Name Theme */}
      <EditableField
        label="Name Theme"
        value={props.nameTheme || ''}
        onChange={(value) => onChange({ nameTheme: value || undefined })}
        placeholder="e.g., animals, greek-gods, nato-phonetic"
      />

      {/* MCP Servers */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          MCP Servers
        </label>

        {/* Selected MCPs */}
        {(props.mcp?.length ?? 0) > 0 && (
          <div className="space-y-1">
            {props.mcp?.map((ref, index) => (
              <div
                key={`${ref.channel || channelId}-${ref.slug}`}
                className="flex items-center gap-2 px-2 py-1.5 bg-secondary/30 rounded border border-border"
              >
                <Server className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <span className="text-base flex-1 truncate">{getMcpDisplay(ref)}</span>
                <button
                  type="button"
                  onClick={() => removeMcp(index)}
                  className="p-0.5 text-muted-foreground hover:text-destructive transition-colors"
                  title="Remove"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add MCP button / picker */}
        {showMcpPicker ? (
          <div className="rounded border border-border bg-secondary/20 p-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-base font-medium text-muted-foreground">Select MCP Server</span>
              <button
                type="button"
                onClick={() => setShowMcpPicker(false)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                title="Cancel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {mcpLoading ? (
              <div className="text-base text-muted-foreground py-2">Loading...</div>
            ) : selectableMcps.length === 0 ? (
              <div className="text-base text-muted-foreground py-2">
                No MCP servers available
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1">
                {selectableMcps.map((mcp) => (
                  <button
                    key={`${mcp.channel}-${mcp.slug}`}
                    type="button"
                    onClick={() => addMcp(mcp)}
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded text-base",
                      "hover:bg-secondary/50 transition-colors"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="truncate">
                        {mcp.title || mcp.slug}
                        {mcp.channel !== channelId && (
                          <span className="text-muted-foreground ml-1">(#{mcp.channel})</span>
                        )}
                      </span>
                    </div>
                    {mcp.tldr && (
                      <div className="text-base text-muted-foreground truncate ml-5.5 mt-0.5">
                        {mcp.tldr}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowMcpPicker(true)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 text-base border border-border",
              "bg-secondary text-foreground hover:bg-secondary/80",
              "transition-colors"
            )}
          >
            <Plus className="w-3.5 h-3.5" />
            Add MCP Server
          </button>
        )}
      </div>

      {/* Channel Starter */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          Channel Starter
        </label>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="featuredChannelStarter"
            checked={props.featuredChannelStarter || false}
            onChange={(e) => onChange({ featuredChannelStarter: e.target.checked || undefined })}
            className="w-4 h-4 bg-secondary border border-border text-foreground accent-foreground focus:ring-0 focus:ring-offset-0"
          />
          <label htmlFor="featuredChannelStarter" className="text-base text-foreground">
            Suggest this agent when starting new channels
          </label>
        </div>
      </div>
    </div>
  )
}
