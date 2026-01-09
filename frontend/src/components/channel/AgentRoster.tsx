import { useState, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { AgentSummonPicker } from './AgentSummonPicker'
import { DismissConfirmDialog } from './DismissConfirmDialog'
import { AgentDetailPopup } from './AgentDetailPopup'
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
  /** Whether agent management is enabled */
  canManageAgents?: boolean
}

// Status dot colors per Cast design
const statusColors: Record<string, string> = {
  working: 'bg-[#de946a] animate-pulse',
  thinking: 'bg-[#de946a] animate-pulse',
  attentive: 'bg-[#de946a]',
  idle: 'bg-[#c0c0c0]',
  offline: 'bg-[#c0c0c0]',
}

interface AgentBadgeProps {
  agent: RosterAgent
  isLeader: boolean
  onDismiss?: () => void
  onClick?: (e: React.MouseEvent) => void
}

/**
 * Individual agent badge with hover dismiss action.
 */
function AgentBadge({ agent, isLeader, onDismiss, onClick }: AgentBadgeProps) {
  const [showDismiss, setShowDismiss] = useState(false)
  const isWorking = agent.status === 'thinking'
  const isAttentive = false // RosterAgent only has 'idle' | 'thinking' | 'offline'

  return (
    <div
      className="relative group"
      onMouseEnter={() => setShowDismiss(true)}
      onMouseLeave={() => setShowDismiss(false)}
    >
      <button
        onClick={onClick}
        className={cn(
          "flex items-center gap-1 text-xs cursor-pointer transition-opacity hover:opacity-80"
        )}
        title={`@${agent.callsign} - ${agent.status}${isLeader ? ' (leader)' : ''}`}
      >
        <span className={cn(
          "w-1.5 h-1.5 rounded-full flex-shrink-0",
          statusColors[agent.status] || statusColors.idle
        )} />
        <span className={cn(
          "transition-colors",
          isWorking && "text-[#de946a]",
          isAttentive && "text-[#de946a]",
          !isWorking && !isAttentive && "text-[#a0a0a0]"
        )}>
          {agent.callsign}
        </span>
        {isLeader && (
          <span className="text-amber-500 text-[10px]">★</span>
        )}
      </button>

      {/* Dismiss button - only show on hover, never for leader */}
      {showDismiss && onDismiss && !isLeader && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
          className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs shadow-sm hover:bg-destructive/90 transition-colors"
          title={`Dismiss @${agent.callsign}`}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}

/**
 * Compact agent roster display for channel header.
 * Shows callsigns with status indicators, add button, and dismiss on hover.
 */
export function AgentRoster({
  roster,
  leader,
  agentTypes: _agentTypes = [],
  channelId,
  apiHost = '',
  onAgentAdded: _onAgentAdded,
  onAgentDismiss,
  canManageAgents = false,
}: AgentRosterProps) {
  // Note: agentTypes and onAgentAdded are deprecated but kept for backwards compatibility
  void _agentTypes
  void _onAgentAdded
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dismissTarget, setDismissTarget] = useState<RosterAgent | null>(null)
  const [dismissPosition, setDismissPosition] = useState<{ bottom: number; left: number } | undefined>()
  const [detailAgent, setDetailAgent] = useState<RosterAgent | null>(null)
  const [detailPosition, setDetailPosition] = useState<{ bottom: number; left: number } | undefined>()
  const addButtonRef = useRef<HTMLButtonElement>(null)

  // Handle agent click - open detail popup (positioned above the trigger)
  const handleAgentClick = (agent: RosterAgent, event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    // Position above: bottom is distance from viewport bottom to trigger top
    setDetailPosition({ bottom: window.innerHeight - rect.top + 8, left: rect.left })
    setDetailAgent(agent)
  }

  // Handle dismiss click - show confirmation for active agents, dismiss immediately otherwise
  const handleDismissClick = (agent: RosterAgent, event: React.MouseEvent) => {
    const isActive = agent.status === 'thinking'

    if (isActive) {
      // Show confirmation dialog (positioned above the trigger)
      const rect = (event.target as HTMLElement).getBoundingClientRect()
      setDismissPosition({ bottom: window.innerHeight - rect.top + 4, left: rect.left - 200 })
      setDismissTarget(agent)
    } else {
      // Dismiss immediately
      onAgentDismiss?.(agent.callsign)
    }
  }

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
        {roster.map((agent) => (
          <AgentBadge
            key={agent.callsign}
            agent={agent}
            isLeader={agent.callsign === leader}
            onClick={(e) => handleAgentClick(agent, e)}
            onDismiss={
              canManageAgents && onAgentDismiss
                ? () => {
                const fakeEvent = { target: document.body, currentTarget: document.body } as unknown as React.MouseEvent
                handleDismissClick(agent, fakeEvent)
              }
                : undefined
            }
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
              "text-[#a0a0a0] hover:text-[var(--cast-text-primary)] transition-colors",
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

      {/* Dismiss confirmation dialog */}
      <DismissConfirmDialog
        callsign={dismissTarget?.callsign || ''}
        isActive={dismissTarget?.status === 'thinking'}
        onConfirm={handleConfirmDismiss}
        onClose={() => setDismissTarget(null)}
        isOpen={!!dismissTarget}
        position={dismissPosition}
      />

      {/* Agent detail popup */}
      {detailAgent && (
        <AgentDetailPopup
          agent={detailAgent}
          onClose={() => setDetailAgent(null)}
          isOpen={!!detailAgent}
          position={detailPosition}
        />
      )}
    </div>
  )
}

// Re-export types for convenience
export type { RosterAgent }
