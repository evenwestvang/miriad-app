import { useState, useEffect, useCallback } from 'react'
import { Loader2, Hash, Coffee } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import type { AvailableAgent } from './AgentSummonPicker'

interface ChannelEmptyStateProps {
  channelId: string
  apiHost: string
  onSelectAgent: (agentSlug: string) => void
}

/**
 * Empty state shown when a channel has no messages yet.
 * Displays an inspiring message about collaboration and shows
 * featured starter agents that users can summon with one click.
 */
export function ChannelEmptyState({
  channelId,
  apiHost,
  onSelectAgent,
}: ChannelEmptyStateProps) {
  const [starterAgents, setStarterAgents] = useState<AvailableAgent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchStarterAgents = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/agents/available`)
      if (response.ok) {
        const data = await response.json()
        const agents = (data.agents || []) as AvailableAgent[]
        // Filter to only featured starters
        const starters = agents.filter(a => a.featuredChannelStarter)
        setStarterAgents(starters)
      }
    } catch (err) {
      console.warn('Failed to load starter agents:', err)
    } finally {
      setIsLoading(false)
    }
  }, [apiHost, channelId])

  useEffect(() => {
    fetchStarterAgents()
  }, [fetchStarterAgents])

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 pb-16 max-w-2xl mx-auto">
      {/* Hero section */}
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Hash className="w-8 h-8 text-primary" />
      </div>

      <h2 className="text-xl font-semibold text-foreground mb-3">
        Welcome to your channel
      </h2>

      <p className="text-muted-foreground text-base leading-relaxed mb-8">
        Channels are spaces where you and AI agents collaborate on projects together.
        Whether it's coding, data analysis, research, or creative exploration —
        summon the agents you need and start working.
      </p>

      {/* Starter agents section */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-base">Loading agents...</span>
        </div>
      ) : starterAgents.length > 0 ? (
        <div className="w-full">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Coffee className="w-4 h-4 text-primary" />
            <span className="text-base font-medium text-foreground">
              Recommended starters
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {starterAgents.map((agent) => (
              <button
                key={agent.slug}
                onClick={() => onSelectAgent(agent.slug)}
                className="group p-4 text-left bg-card border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/30 transition-colors"
              >
                <div className="font-medium text-base text-foreground group-hover:text-primary transition-colors">
                  {agent.title || agent.slug}
                </div>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {agent.tldr}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Use the summon button in the roster bar to add agents to this channel.
        </p>
      )}
    </div>
  )
}
