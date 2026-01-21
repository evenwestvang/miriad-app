import { useState, useRef, useEffect } from 'react'
import {
  X,
  Bot,
  BotOff,
  Bed,
  Cloud,
  Laptop,
  Loader2,
  MoreVertical,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { RosterAgent } from './MentionAutocomplete'

interface AgentDetailPanelProps {
  /** Selected agent to display */
  agent: RosterAgent
  /** Channel ID for API calls */
  channelId: string
  /** API host for actions */
  apiHost: string
  /** Called when panel is closed */
  onClose: () => void
  /** Called after agent is dismissed */
  onDismiss?: (callsign: string) => void
  /** Called immediately when mute is clicked (optimistic update) */
  onMute?: (callsign: string) => void
  /** Called immediately when unmute is clicked (optimistic update) */
  onUnmute?: (callsign: string) => void
}

/**
 * Get state badge info from agent state
 */
function getStateBadge(agent: RosterAgent): { label: string; colorClass: string } {
  if (agent.isPaused) {
    return { label: 'Muted', colorClass: 'bg-amber-500 text-white' }
  }
  if (!agent.isOnline) {
    return { label: 'Offline', colorClass: 'bg-gray-500 text-white' }
  }
  if (agent.isWorking) {
    return { label: 'Working', colorClass: 'bg-blue-500 text-white' }
  }
  if (agent.isPending) {
    return { label: 'Pending', colorClass: 'bg-cyan-500 text-white' }
  }
  return { label: 'Online', colorClass: 'bg-green-500 text-white' }
}

/**
 * Full-width agent detail panel that appears above the roster.
 * Shows agent info, status, cost, tunnels, and action buttons.
 */
export function AgentDetailPanel({
  agent,
  channelId,
  apiHost,
  onClose,
  onDismiss,
  onMute,
  onUnmute,
}: AgentDetailPanelProps) {
  const [actionLoading, setActionLoading] = useState<'pause' | 'resume' | 'dismiss' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const stateBadge = getStateBadge(agent)

  // Format cost display
  const costDisplay = agent.sessionCost !== undefined && agent.sessionCost > 0
    ? `$${agent.sessionCost < 0.01 ? agent.sessionCost.toFixed(4) : agent.sessionCost.toFixed(2)}`
    : '$0.00'

  // Handle pause action (mute)
  const handlePause = async () => {
    // Optimistic update - reflect immediately in UI
    onMute?.(agent.callsign)
    setActionLoading('pause')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}/pause`,
        { method: 'POST', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to pause agent:', data.error || response.status)
        // Revert on failure - unmute
        onUnmute?.(agent.callsign)
      }
    } catch (err) {
      console.error('Failed to pause agent:', err)
      // Revert on failure - unmute
      onUnmute?.(agent.callsign)
    } finally {
      setActionLoading(null)
    }
  }

  // Handle resume action (unmute)
  const handleResume = async () => {
    // Optimistic update - reflect immediately in UI
    onUnmute?.(agent.callsign)
    setActionLoading('resume')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}/resume`,
        { method: 'POST', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to resume agent:', data.error || response.status)
        // Revert on failure - mute again
        onMute?.(agent.callsign)
      }
    } catch (err) {
      console.error('Failed to resume agent:', err)
      // Revert on failure - mute again
      onMute?.(agent.callsign)
    } finally {
      setActionLoading(null)
    }
  }

  // Handle dismiss action
  const handleDismiss = async () => {
    // Optimistic update - remove from roster and close panel immediately
    onDismiss?.(agent.callsign)
    onClose()

    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}`,
        { method: 'DELETE', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to dismiss agent:', data.error || response.status)
        // Note: We don't revert on failure because the WebSocket broadcast
        // will sync the correct state. If the backend failed, the agent
        // will reappear when we get the next roster update.
      }
    } catch (err) {
      console.error('Failed to dismiss agent:', err)
    }
  }

  // Derive status description
  const getStatusDescription = () => {
    // Show explicit status from agent if available
    if (agent.current?.status) return agent.current.status

    // Fall back to derived status
    if (agent.isPaused) return 'Muted — will not respond to mentions'
    if (!agent.isOnline) return 'Offline — runtime not connected'
    if (agent.isWorking) return 'Working on a task'
    if (agent.isPending) return 'Pending — waiting for response'
    return 'Idle — ready for work'
  }

  return (
    <div className="px-4 py-3 bg-[var(--cast-bg-primary)]">
      {/* Two-row layout */}
      <div className="flex flex-col gap-2">
        {/* Top row: callsign, agent type, status badge, actions, close */}
        <div className="flex items-center gap-3">
          {/* Agent identity + status badge */}
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
              {agent.callsign}
            </span>
            {agent.agentType && (
              <span className="text-[14px] font-normal text-[var(--cast-text-muted)]">
                {agent.agentType}
              </span>
            )}
            {/* Status badge */}
            <span className={cn(
              "px-2 py-0.5 text-xs font-medium",
              stateBadge.colorClass
            )}>
              {stateBadge.label}
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Desktop: inline action buttons */}
          <div className="hidden sm:flex items-center gap-1">
            {agent.isPaused ? (
              <button
                onClick={handleResume}
                disabled={actionLoading !== null}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 text-base",
                  "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {actionLoading === 'resume' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Bot className="w-4 h-4" />
                )}
                Unmute
              </button>
            ) : (
              <button
                onClick={handlePause}
                disabled={actionLoading !== null}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 text-base",
                  "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {actionLoading === 'pause' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <BotOff className="w-4 h-4" />
                )}
                Mute
              </button>
            )}
            <button
              onClick={handleDismiss}
              disabled={actionLoading !== null}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 text-base",
                "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {actionLoading === 'dismiss' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Bed className="w-4 h-4" />
              )}
              Dismiss
            </button>
          </div>

          {/* Mobile: kebab menu */}
          <div className="relative sm:hidden" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]"
              title="Actions"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {/* Dropdown menu */}
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-card border border-[var(--cast-border-default)] shadow-sm z-10 min-w-[140px]">
                {/* Mute/Unmute - always available */}
                {agent.isPaused ? (
                  <button
                    onClick={() => { handleResume(); setMenuOpen(false) }}
                    disabled={actionLoading !== null}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
                      "text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    {actionLoading === 'resume' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Bot className="w-4 h-4" />
                    )}
                    Unmute
                  </button>
                ) : (
                  <button
                    onClick={() => { handlePause(); setMenuOpen(false) }}
                    disabled={actionLoading !== null}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
                      "text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    {actionLoading === 'pause' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <BotOff className="w-4 h-4" />
                    )}
                    Mute
                  </button>
                )}
                <button
                  onClick={() => { handleDismiss(); setMenuOpen(false) }}
                  disabled={actionLoading !== null}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
                    "text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {actionLoading === 'dismiss' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Bed className="w-4 h-4" />
                  )}
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-1 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[var(--cast-bg-secondary)]"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Bottom row: status, cost, tunnel, env */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-[var(--cast-text-muted)]">
          <span>{getStatusDescription()}</span>
          <span>·</span>
          <span className="font-mono">{costDisplay}</span>
          <span>·</span>
          <span className="flex items-center gap-1">
            {agent.runtimeId ? (
              <Laptop className="w-3.5 h-3.5" />
            ) : (
              <Cloud className="w-3.5 h-3.5" />
            )}
            {agent.runtimeName || 'Miriad Cloud'}
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                agent.runtimeStatus === 'online' ? "bg-green-500" : "bg-gray-400"
              )}
            />
            <span>{agent.runtimeStatus === 'online' ? 'connected' : 'offline'}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
