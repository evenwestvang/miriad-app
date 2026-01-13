import { useState, useRef, useEffect } from 'react'
import {
  X,
  Bot,
  BotOff,
  Bed,
  Cloud,
  Laptop,
  ExternalLink,
  Copy,
  Check,
  Loader2,
  Circle,
  MoreVertical,
  Coffee,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { getRosterColor } from '../../utils/senderColors'
import type { RosterAgent } from './MentionAutocomplete'

// Tunnel domain from environment, defaults to production
const TUNNEL_DOMAIN = import.meta.env.VITE_TUNNEL_DOMAIN || 'cast-stack.site'

interface AgentDetailPanelProps {
  /** Selected agent to display */
  agent: RosterAgent
  /** Agent's index in roster (for color) */
  rosterIndex: number
  /** Channel ID for color calculation and API calls */
  channelId: string
  /** API host for actions */
  apiHost: string
  /** Called when panel is closed */
  onClose: () => void
  /** Called after agent is dismissed */
  onDismiss?: (callsign: string) => void
}

/**
 * Get state badge info from agent state
 */
function getStateBadge(agent: RosterAgent): { label: string; colorClass: string } {
  if (agent.isPaused) {
    return { label: 'Muted', colorClass: 'bg-amber-500 text-white' }
  }
  if (agent.isConnecting) {
    return { label: 'Connecting', colorClass: 'bg-yellow-500 text-black' }
  }
  if (!agent.isOnline) {
    return { label: 'Suspended', colorClass: 'bg-gray-500 text-white' }
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
  rosterIndex,
  channelId,
  apiHost,
  onClose,
  onDismiss,
}: AgentDetailPanelProps) {
  const [copied, setCopied] = useState(false)
  const [actionLoading, setActionLoading] = useState<'pause' | 'resume' | 'dismiss' | 'activate' | null>(null)
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

  // Get agent's color based on roster position
  const dotColor = getRosterColor(channelId, rosterIndex)
  const stateBadge = getStateBadge(agent)

  // Construct tunnel URL from hash
  const tunnelUrl = agent.tunnelHash
    ? `https://${agent.tunnelHash}.${TUNNEL_DOMAIN}`
    : null

  // Format cost display
  const costDisplay = agent.sessionCost !== undefined && agent.sessionCost > 0
    ? `$${agent.sessionCost < 0.01 ? agent.sessionCost.toFixed(4) : agent.sessionCost.toFixed(2)}`
    : '$0.00'

  // Copy tunnel URL to clipboard
  const handleCopyUrl = async () => {
    if (!tunnelUrl) return
    try {
      await navigator.clipboard.writeText(tunnelUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy URL:', err)
    }
  }

  // Handle pause action
  const handlePause = async () => {
    setActionLoading('pause')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}/pause`,
        { method: 'POST', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to pause agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to pause agent:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // Handle resume action
  const handleResume = async () => {
    setActionLoading('resume')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}/resume`,
        { method: 'POST', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to resume agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to resume agent:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // Handle dismiss action
  const handleDismiss = async () => {
    setActionLoading('dismiss')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}`,
        { method: 'DELETE', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to dismiss agent:', data.error || response.status)
      } else {
        onDismiss?.(agent.callsign)
        onClose()
      }
    } catch (err) {
      console.error('Failed to dismiss agent:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // Handle activate action (for suspended agents)
  const handleActivate = async () => {
    setActionLoading('activate')
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${agent.callsign}/activate`,
        { method: 'POST', credentials: 'include' }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to activate agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to activate agent:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // Derive status description
  const getStatusDescription = () => {
    // Show explicit status from agent if available
    if (agent.current?.status) return agent.current.status

    // Fall back to derived status
    if (agent.isPaused) return 'Muted — will not respond to mentions'
    if (agent.isConnecting) return 'Starting container...'
    if (!agent.isOnline) return 'Suspended — container stopped'
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
            <Circle
              size={14}
              color={dotColor}
              fill={dotColor}
              strokeWidth={0}
              className="flex-shrink-0"
            />
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

          {/* Wide: inline action buttons (hidden on narrow) */}
          <div className="hidden sm:flex items-center gap-1">
            {/* Activate button for suspended agents */}
            {!agent.isOnline && !agent.isConnecting && (
              <button
                onClick={handleActivate}
                disabled={actionLoading !== null}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 text-sm",
                  "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {actionLoading === 'activate' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Coffee className="w-4 h-4" />
                )}
                Activate
              </button>
            )}
            {/* Mute/Unmute - always available */}
            {agent.isPaused ? (
              <button
                onClick={handleResume}
                disabled={actionLoading !== null}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 text-sm",
                  "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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
                  "flex items-center gap-1.5 px-2 py-1 text-sm",
                  "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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
                "flex items-center gap-1.5 px-2 py-1 text-sm",
                "text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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

          {/* Narrow: kebab menu (hidden on wide) */}
          <div className="relative sm:hidden" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]"
              title="Actions"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {/* Dropdown menu */}
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-[#e5e5e5] shadow-sm z-10 min-w-[140px]">
                {/* Activate for suspended agents */}
                {!agent.isOnline && !agent.isConnecting && (
                  <button
                    onClick={() => { handleActivate(); setMenuOpen(false) }}
                    disabled={actionLoading !== null}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                      "text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    {actionLoading === 'activate' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Coffee className="w-4 h-4" />
                    )}
                    Activate
                  </button>
                )}
                {/* Mute/Unmute - always available */}
                {agent.isPaused ? (
                  <button
                    onClick={() => { handleResume(); setMenuOpen(false) }}
                    disabled={actionLoading !== null}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                      "text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                      "text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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
                    "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                    "text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]",
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
            className="p-1 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Bottom row: status, cost, tunnel, env */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--cast-text-muted)]">
          <span>{getStatusDescription()}</span>
          <span>·</span>
          <span className="font-mono">{costDisplay}</span>
          {tunnelUrl && (
            <>
              <span>·</span>
              <div className="flex items-center gap-1">
                <a
                  href={tunnelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--cast-text-primary)] flex items-center gap-1"
                >
                  web
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button
                  onClick={handleCopyUrl}
                  className="p-0.5 hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]"
                  title="Copy URL"
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-green-600" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            </>
          )}
          <span>·</span>
          <span className="flex items-center gap-1">
            {agent.runtimeId ? (
              <>
                <Laptop className="w-3.5 h-3.5" />
                {agent.runtimeName || 'Local'}
              </>
            ) : (
              <>
                <Cloud className="w-3.5 h-3.5" />
                CAST Cloud
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
