import { useState } from 'react'
import { cn } from '../../lib/utils'
import { AgentSummonPicker } from './AgentSummonPicker'
import { DismissConfirmDialog } from './DismissConfirmDialog'
import { PendingAsksIndicator } from './PendingAsksIndicator'
import type { RosterAgent } from './MentionAutocomplete'
import type { Message } from '../../types'

// Re-export AgentType for backwards compatibility (used in App.tsx)
export interface AgentType {
  id: string
  name: string
  description?: string
}

interface AgentRosterProps {
  roster: RosterAgent[]
  leader?: string
  /** @deprecated No longer used - AgentSummonPicker fetches agents from API */
  agentTypes?: AgentType[]
  /** Channel ID for API calls */
  channelId?: string
  /** Channel name for contextual name generation */
  channelName?: string
  /** Space ID for runtime fetching */
  spaceId?: string
  /** API host */
  apiHost?: string
  /** @deprecated No longer used - roster updates via WebSocket */
  onAgentAdded?: (agent: RosterAgent) => void
  /** Called when agent is dismissed */
  onAgentDismiss?: (callsign: string) => void
  /** Called when agent badge is clicked (for detail panel) */
  onAgentSelect?: (callsign: string) => void
  /** Currently selected agent callsign */
  selectedAgent?: string | null
  /** Whether agent management is enabled */
  canManageAgents?: boolean
  /** Controlled: is summon picker open */
  summonOpen?: boolean
  /** Controlled: called when summon picker should close */
  onSummonClose?: () => void
  /** Pre-selected agent slug - skips browse and goes to configure */
  preSelectedAgentSlug?: string
  /** All messages for pending asks indicator */
  messages?: Message[]
  /** Called when a structured ask is submitted */
  onStructuredAskSubmit?: (messageId: string, response: Record<string, unknown>) => void
  /** Called when a structured ask is cancelled */
  onStructuredAskCancel?: (messageId: string) => void
}

interface AgentBadgeProps {
  agent: RosterAgent
  isLeader: boolean
  isSelected: boolean
  onClick?: () => void
}

/**
 * Individual agent badge with visual states:
 * 1. Offline: Gray name
 * 2. Online/Idle: Black name
 * 3. Working: Black name with animation
 * 4. Paused: Strikethrough black name
 *
 * Selected state adds background highlight.
 */
function AgentBadge({ agent, isLeader, isSelected, onClick }: Omit<AgentBadgeProps, 'channelId' | 'rosterIndex'>) {
  // Derive state label for tooltip
  const stateLabel = agent.isPaused
    ? 'muted'
    : !agent.isOnline
      ? 'offline'
      : agent.isWorking
        ? 'working'
        : agent.isPending
          ? 'pending'
          : 'idle'

  // Runtime info for tooltip
  const runtimeLabel = agent.runtimeName || 'Miriad Cloud'

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-xs cursor-pointer px-1.5 py-0.5",
        "hover:bg-[var(--cast-bg-secondary)]",
        isSelected && "bg-[var(--cast-bg-secondary)] font-semibold"
      )}
      title={`@${agent.callsign} - ${stateLabel}${isLeader ? ' (leader)' : ''} • ${runtimeLabel}`}
    >
      {/* Name: color based on online/offline, strikethrough added if muted */}
      <span className={cn(
        // Base color: gray for offline, black otherwise
        agent.isOnline
          ? "text-[var(--cast-text-primary)]"
          : "text-[#a0a0a0]",
        // Working animation (only when online and working)
        agent.isOnline && agent.isWorking && "animate-working",
        // Strikethrough for muted (independent of online/offline)
        agent.isPaused && "line-through"
      )}>
        {agent.callsign}
      </span>
      {isLeader && (
        <span className="text-amber-500 text-[10px]">★</span>
      )}
    </button>
  )
}

/**
 * Compact agent roster display for channel header.
 * Shows callsigns with status indicators, acts as tab navigation for detail panel.
 * Dismiss functionality is in the detail panel, not on hover.
 */
export function AgentRoster({
  roster,
  leader,
  agentTypes: _agentTypes = [],
  channelId,
  channelName,
  spaceId,
  apiHost = '',
  onAgentAdded: _onAgentAdded,
  onAgentDismiss,
  onAgentSelect,
  selectedAgent,
  canManageAgents = false,
  summonOpen = false,
  onSummonClose,
  preSelectedAgentSlug,
  messages = [],
  onStructuredAskSubmit,
  onStructuredAskCancel,
}: AgentRosterProps) {
  // Note: agentTypes and onAgentAdded are deprecated but kept for backwards compatibility
  void _agentTypes
  void _onAgentAdded
  const [dismissTarget, setDismissTarget] = useState<RosterAgent | null>(null)

  const handleConfirmDismiss = () => {
    if (dismissTarget) {
      onAgentDismiss?.(dismissTarget.callsign)
      setDismissTarget(null)
    }
  }

  // Empty roster state
  if (roster.length === 0 && !canManageAgents) {
    return null
  }

  return (
    <div className="relative flex flex-wrap items-center justify-between gap-y-2 text-xs text-[#8c8c8c]">
      {/* Agent roster - horizontal list that wraps */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {roster.map((agent) => (
          <AgentBadge
            key={agent.callsign}
            agent={agent}
            isLeader={agent.callsign === leader}
            isSelected={agent.callsign === selectedAgent}
            onClick={() => onAgentSelect?.(agent.callsign)}
          />
        ))}

        {/* Empty state inline */}
        {roster.length === 0 && !canManageAgents && (
          <span className="text-[var(--cast-text-muted)]">No agents</span>
        )}
      </div>

      {/* Pending asks indicator - right side */}
      {channelId && (
        <PendingAsksIndicator
          channelId={channelId}
          messages={messages}
          spaceId={spaceId}
          roster={roster}
          onSubmit={onStructuredAskSubmit}
          onCancel={onStructuredAskCancel}
        />
      )}

      {/* Summon agent picker (controlled by parent via summonOpen prop) */}
      {canManageAgents && channelId && (
        <AgentSummonPicker
          roster={roster}
          channelId={channelId}
          channelName={channelName}
          spaceId={spaceId}
          apiHost={apiHost}
          onClose={() => onSummonClose?.()}
          isOpen={summonOpen}
          preSelectedAgentSlug={preSelectedAgentSlug}
        />
      )}

      {/* Dismiss confirmation dialog - used when dismissing working agent from panel */}
      <DismissConfirmDialog
        callsign={dismissTarget?.callsign || ''}
        isActive={dismissTarget?.isWorking ?? false}
        onConfirm={handleConfirmDismiss}
        onClose={() => setDismissTarget(null)}
        isOpen={!!dismissTarget}
      />
    </div>
  )
}

// Re-export types for convenience
export type { RosterAgent }
