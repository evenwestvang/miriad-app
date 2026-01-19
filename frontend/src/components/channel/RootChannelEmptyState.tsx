import { Radical } from 'lucide-react'

/**
 * Empty state shown when the root channel has no messages.
 * Explains that the root channel contains globally available resources.
 */
export function RootChannelEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 pb-16 max-w-2xl mx-auto">
      {/* Hero section */}
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Radical className="w-8 h-8 text-primary" />
      </div>

      <h2 className="text-xl font-semibold text-foreground mb-3">
        Root Channel
      </h2>

      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        This is your workspace's root channel. Everything defined on this channel's board
        is available across all other channels.
      </p>

      <div className="space-y-2 text-left w-full max-w-md">
        <div className="py-1">
          <div className="font-medium text-sm text-foreground">
            Agent Definitions
          </div>
          <p className="text-xs text-muted-foreground">
            Agents defined here can be summoned in any channel.
          </p>
        </div>

        <div className="py-1">
          <div className="font-medium text-sm text-foreground">
            MCP Servers
          </div>
          <p className="text-xs text-muted-foreground">
            MCP servers configured here are available to all agents.
          </p>
        </div>

        <div className="py-1">
          <div className="font-medium text-sm text-foreground">
            Playbooks
          </div>
          <p className="text-xs text-muted-foreground">
            Playbooks defined here guide agents wherever they work.
          </p>
        </div>
      </div>
    </div>
  )
}
