import { useState, useEffect } from 'react'
import { Bot, Check } from 'lucide-react'
import { EditableField } from '../ui/editable-field'
import { apiFetch } from '../../lib/api'
import { cn } from '../../lib/utils'

// Focus props types - matches server schema
export interface FocusProps {
  agents: string[] // Required - at least one agent slug
  defaultTagline?: string
  defaultMission?: string
  initialPrompt?: string
}

interface FocusPropsEditorProps {
  props: FocusProps
  onChange: (updates: Partial<FocusProps>) => void
  apiHost: string
}

// Available agent artifact from API
interface AgentArtifact {
  slug: string
  title?: string
  tldr: string
}

export function FocusPropsEditor({ props, onChange, apiHost }: FocusPropsEditorProps) {
  const [availableAgents, setAvailableAgents] = useState<AgentArtifact[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)

  // Fetch available agents from #root
  useEffect(() => {
    async function fetchAgents() {
      setAgentsLoading(true)
      try {
        const response = await apiFetch(`${apiHost}/channels/root/artifacts?type=system.agent`)
        if (response.ok) {
          const data = await response.json()
          setAvailableAgents(data.artifacts || [])
        }
      } catch (error) {
        console.error('Failed to fetch agents:', error)
      } finally {
        setAgentsLoading(false)
      }
    }

    fetchAgents()
  }, [apiHost])

  // Toggle agent selection
  const toggleAgent = (slug: string) => {
    const currentAgents = props.agents || []
    const isSelected = currentAgents.includes(slug)

    if (isSelected) {
      // Don't allow removing if it's the last one
      if (currentAgents.length <= 1) return
      onChange({ agents: currentAgents.filter((a) => a !== slug) })
    } else {
      onChange({ agents: [...currentAgents, slug] })
    }
  }

  const selectedAgents = props.agents || []

  return (
    <div className="space-y-8">
      {/* Starting Agents */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          Starting Agents
          <span className="text-muted-foreground/70 ml-1">*</span>
        </label>
        <p className="text-base text-muted-foreground">
          Select which agent types are available when creating a channel with this focus
        </p>

        {agentsLoading ? (
          <div className="text-base text-muted-foreground py-2">Loading agents...</div>
        ) : availableAgents.length === 0 ? (
          <div className="text-base text-muted-foreground py-2">
            No agent definitions found in #root
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {availableAgents.map((agent) => {
              const isSelected = selectedAgents.includes(agent.slug)
              const isLastSelected = isSelected && selectedAgents.length === 1

              return (
                <button
                  key={agent.slug}
                  type="button"
                  onClick={() => toggleAgent(agent.slug)}
                  disabled={isLastSelected}
                  title={
                    isLastSelected
                      ? 'At least one agent is required'
                      : isSelected
                        ? `Remove ${agent.title || agent.slug}`
                        : `Add ${agent.title || agent.slug}`
                  }
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1.5 text-base rounded-md border transition-colors",
                    isSelected
                      ? "bg-secondary text-foreground border-muted-foreground"
                      : "bg-secondary/30 text-foreground border-border hover:border-muted-foreground hover:bg-secondary/50",
                    isLastSelected && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {isSelected ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Bot className="w-3.5 h-3.5" />
                  )}
                  {agent.title || agent.slug}
                </button>
              )
            })}
          </div>
        )}

        {selectedAgents.length > 0 && (
          <div className="text-base text-muted-foreground">
            {selectedAgents.length} agent{selectedAgents.length === 1 ? '' : 's'} selected
          </div>
        )}
      </div>

      {/* Default Tagline */}
      <EditableField
        label="Default Tagline"
        value={props.defaultTagline || ''}
        onChange={(value) => onChange({ defaultTagline: value || undefined })}
        placeholder="e.g., A new Research project"
      />

      {/* Default Mission */}
      <EditableField
        label="Default Mission"
        value={props.defaultMission || ''}
        onChange={(value) => onChange({ defaultMission: value || undefined })}
        placeholder="Describe the channel's purpose and how to approach it..."
        multiline
        minHeight="min-h-[80px]"
      />

      {/* Initial Prompt */}
      <EditableField
        label="Initial Prompt"
        value={props.initialPrompt || ''}
        onChange={(value) => onChange({ initialPrompt: value || undefined })}
        placeholder="Optional message to send when channel is created..."
        multiline
        minHeight="min-h-[60px]"
      />
    </div>
  )
}
