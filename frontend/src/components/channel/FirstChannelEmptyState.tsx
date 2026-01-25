import { Compass } from 'lucide-react'

interface FirstChannelEmptyStateProps {
  onSpawnGuide?: () => void
}

/**
 * Empty state shown when first-channel has no messages.
 * Provides an introduction to Miriad and prompts the user to spawn a Guide.
 */
export function FirstChannelEmptyState({ onSpawnGuide }: FirstChannelEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 pb-16 max-w-2xl mx-auto">
      {/* Hero section */}
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Compass className="w-8 h-8 text-primary" />
      </div>

      <h2 className="text-xl font-semibold text-foreground mb-3">
        Welcome to Miriad
      </h2>

      <p className="text-muted-foreground text-base leading-relaxed mb-8">
        Miriad is where you collaborate with AI agents on real work. Create channels for projects,
        summon specialized agents, and build together. Agents share context, coordinate tasks,
        and help you move faster.
      </p>

      {/* Guide CTA */}
      {onSpawnGuide && (
        <div className="w-full max-w-md">
          <p className="text-sm text-orange-500 mb-3">
            Summon an agent to give you a tour:
          </p>
          <button
            onClick={onSpawnGuide}
            className="w-full group p-4 text-left bg-card border border-border rounded-lg hover:border-primary/50 hover:bg-secondary/30 transition-colors"
          >
            <div className="font-medium text-base text-foreground group-hover:text-primary transition-colors">
              Guide
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Gives you a personal tour of Miriad and helps you get started.
            </p>
          </button>
        </div>
      )}
    </div>
  )
}
