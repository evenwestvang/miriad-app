import { useState, useRef } from 'react'
import { Plus } from 'lucide-react'
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
 * 4. Working: Colored dot, black name with animation
 * 5. Paused: Gray dot, strikethrough black name
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
          : 'idle'

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
      title={`@${agent.callsign} - ${stateLabel}${isLeader ? ' (leader)' : ''}`}
    >
      {/* Dot: gray for paused/offline, yellow+pulse for connecting, colored when online */}
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full flex-shrink-0",
          agent.isConnecting && "animate-pulse"
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
  apiHost = '',
  onAgentAdded: _onAgentAdded,
  onAgentDismiss,
  onAgentSelect,
  selectedAgent,
  canManageAgents = false,
}: AgentRosterProps) {
  // Note: agentTypes and onAgentAdded are deprecated but kept for backwards compatibility
  void _agentTypes
  void _onAgentAdded
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dismissTarget, setDismissTarget] = useState<RosterAgent | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

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
    <div className="relative flex items-center justify-between text-xs text-[#8c8c8c]">
      {/* Agent roster - horizontal list */}
      <div className="flex items-center gap-3">
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

      {/* Summon agent button - inline on the right */}
      {canManageAgents && channelId && (
        <div className="relative z-10">
          <button
            ref={addButtonRef}
            onClick={() => setPickerOpen(true)}
            className={cn(
              "flex items-center gap-1 text-xs",
              "text-[#a0a0a0] hover:text-[var(--cast-text-primary)]",
              pickerOpen && "text-[var(--cast-text-primary)] pointer-events-none"
            )}
          >
            <Plus className="w-3 h-3" />
            <span>Summon</span>
          </button>

          <AgentSummonPicker
            roster={roster}
            channelId={channelId}
            apiHost={apiHost}
            onClose={() => setPickerOpen(false)}
            isOpen={pickerOpen}
          />
        </div>
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
