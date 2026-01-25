import { Radical } from 'lucide-react'

interface RootChannelEmptyStateProps {
  onSpawnCustodian?: () => void
}

/**
 * Empty state shown when the root channel has no messages.
 * Explains that the root channel contains globally available resources
 * and prompts the user to spawn a Custodian agent.
 */
export function RootChannelEmptyState({ onSpawnCustodian }: RootChannelEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 pb-16 max-w-2xl mx-auto">
      {/* Hero section */}
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Radical className="w-8 h-8 text-primary" />
      </div>

      <h2 className="text-xl font-semibold text-foreground mb-3">
        Root Channel
      </h2>

      <p className="text-muted-foreground text-base leading-relaxed mb-6">
        This is your workspace's root channel. Everything defined on this channel's board
        is available across all other channels.
      </p>

      <div className="space-y-2 text-left w-full max-w-md mb-8">
        <div className="py-1">
          <div className="font-medium text-base text-foreground">
            Agent Definitions
          </div>
          <p className="text-xs text-muted-foreground">
            Agents defined here can be summoned in any channel.
          </p>
        </div>

        <div className="py-1">
          <div className="font-medium text-base text-foreground">
            MCP Servers
          </div>
          <p className="text-xs text-muted-foreground">
            MCP servers configured here are available to all agents.
          </p>
        </div>

        <div className="py-1">
          <div className="font-medium text-base text-foreground">
            Playbooks
          </div>
          <p className="text-xs text-muted-foreground">
            Playbooks defined here guide agents wherever they work.
          </p>
        </div>
      </div>

      {/* Custodian CTA */}
      {onSpawnCustodian && (
        <div className="w-full max-w-md">
          <p className="text-sm text-orange-500 mb-3">
            Summon an agent to help you customize your space:
          </p>
          <button
            onClick={onSpawnCustodian}
            className="w-full group p-4 text-left bg-card border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/30 transition-colors"
          >
            <div className="font-medium text-base text-foreground group-hover:text-primary transition-colors">
              Custodian
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Helps you configure agent definitions, playbooks, and workspace settings.
            </p>
          </button>
        </div>
      )}
    </div>
  )
}
