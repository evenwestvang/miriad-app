import { useState } from 'react'
import { Monitor } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getRosterColor } from '../../utils/senderColors'
import { AgentSummonPicker } from './AgentSummonPicker'
import { DismissConfirmDialog } from './DismissConfirmDialog'
import type { RosterAgent } from './MentionAutocomplete'

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
}

interface AgentBadgeProps {
  agent: RosterAgent
  isLeader: boolean
  isSelected: boolean
  /** Channel ID for color calculation */
  channelId: string
  /** Agent's index in the roster (for color assignment) */
  rosterIndex: number
  onClick?: () => void
}

/**
 * Individual agent badge with visual states:
 * 1. Offline: Gray dot, gray name
 * 2. Connecting: Yellow pulsing dot, normal name
 * 3. Online/Idle: Colored dot, black name
 * 4. Pending: Colored dot with subtle pulse, black name
 * 5. Working: Colored dot, black name with animation
 * 6. Paused: Gray dot, strikethrough black name
 *
 * Selected state adds underline indicator.
 */
function AgentBadge({ agent, isLeader, isSelected, channelId, rosterIndex, onClick }: AgentBadgeProps) {
  // Get agent's color based on roster position (matches message list cartouche)
  const dotColor = getRosterColor(channelId, rosterIndex)

  // Derive state label for tooltip
  const stateLabel = agent.isPaused
    ? 'muted'
    : agent.isConnecting
      ? 'connecting'
      : !agent.isOnline
        ? 'offline'
        : agent.isWorking
          ? 'working'
          : agent.isPending
            ? 'pending'
            : 'idle'

  // Runtime info for tooltip
  const runtimeLabel = agent.runtimeId
    ? agent.runtimeName || 'local'
    : 'cloud'

  // Derive dot color: yellow for connecting, gray for offline, otherwise signature color
  // Muted state doesn't affect dot color - only adds strikethrough to name
  const displayDotColor = agent.isConnecting
    ? '#eab308' // yellow-500
    : agent.isOnline
      ? dotColor
      : '#a0a0a0'

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-xs cursor-pointer px-1.5 py-0.5",
        "hover:bg-[#f5f5f5]",
        isSelected && "bg-[#f5f5f5]"
      )}
      title={`@${agent.callsign} - ${stateLabel}${isLeader ? ' (leader)' : ''} • ${runtimeLabel}`}
    >
      {/* Dot: gray for paused/offline, yellow+pulse for connecting, subtle pulse for pending, colored when online */}
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full flex-shrink-0",
          agent.isConnecting && "animate-pulse",
          agent.isOnline && agent.isPending && !agent.isWorking && "animate-pending"
        )}
        style={{ backgroundColor: displayDotColor }}
      />
      {/* Name: color based on online/offline, strikethrough added if muted */}
      <span className={cn(
        // Base color: gray for offline, black otherwise
        agent.isOnline || agent.isConnecting
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
      {agent.runtimeId && (
        <Monitor className="w-2.5 h-2.5 text-muted-foreground" />
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
  spaceId,
  apiHost = '',
  onAgentAdded: _onAgentAdded,
  onAgentDismiss,
  onAgentSelect,
  selectedAgent,
  canManageAgents = false,
  summonOpen = false,
  onSummonClose,
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
        {roster.map((agent, index) => (
          <AgentBadge
            key={agent.callsign}
            agent={agent}
            isLeader={agent.callsign === leader}
            isSelected={agent.callsign === selectedAgent}
            channelId={channelId || ''}
            rosterIndex={index}
            onClick={() => onAgentSelect?.(agent.callsign)}
          />
        ))}

        {/* Empty state inline */}
        {roster.length === 0 && !canManageAgents && (
          <span className="text-[var(--cast-text-muted)]">No agents</span>
        )}
      </div>

      {/* Summon agent picker (controlled by parent via summonOpen prop) */}
      {canManageAgents && channelId && (
        <AgentSummonPicker
          roster={roster}
          channelId={channelId}
          spaceId={spaceId}
          apiHost={apiHost}
          onClose={() => onSummonClose?.()}
          isOpen={summonOpen}
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
