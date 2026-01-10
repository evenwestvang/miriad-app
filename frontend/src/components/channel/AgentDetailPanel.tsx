import { useState } from 'react'
import {
  X,
  MessageCircleOff,
  MessageCircle,
  Bed,
  Cloud,
  ExternalLink,
  Copy,
  Check,
  Loader2,
  Circle,
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
    return { label: 'Offline', colorClass: 'bg-gray-500 text-white' }
  }
  if (agent.isWorking) {
    return { label: 'Working', colorClass: 'bg-blue-500 text-white' }
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
  const [actionLoading, setActionLoading] = useState<'pause' | 'resume' | 'dismiss' | null>(null)

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

  // Derive status description
  const getStatusDescription = () => {
    if (agent.isPaused) return 'Muted — will not respond to mentions'
    if (agent.isConnecting) return 'Starting container...'
    if (!agent.isOnline) return 'Offline — no recent heartbeat'
    if (agent.isWorking) return 'Working on a task'
    return 'Idle — ready for work'
  }

  return (
    <div className="px-4 py-3 bg-[var(--cast-bg-primary)]">
      {/* Single row layout - info left, actions right */}
      <div className="flex items-center gap-4">
        {/* Left section: Agent identity */}
        <div className="flex items-center gap-2">
          {/* Colored circle - matches Cartouche style */}
          <Circle
            size={14}
            color={dotColor}
            fill={dotColor}
            strokeWidth={0}
            className="flex-shrink-0"
          />
          {/* Callsign */}
          <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
            {agent.callsign}
          </span>
          {/* Agent type */}
          {agent.agentType && (
            <span className="text-[14px] font-normal text-[var(--cast-text-muted)]">
              {agent.agentType}
            </span>
          )}
        </div>

        {/* Separator */}
        <span className="text-[var(--cast-text-muted)]">·</span>

        {/* Status description */}
        <span className="text-sm text-[var(--cast-text-muted)]">
          {getStatusDescription()}
        </span>

        {/* Separator */}
        <span className="text-[var(--cast-text-muted)]">·</span>

        {/* Cost */}
        <span className="text-sm font-mono text-[var(--cast-text-muted)]">
          {costDisplay}
        </span>

        {/* Tunnel link (if available) */}
        {tunnelUrl && (
          <>
            <span className="text-[var(--cast-text-muted)]">·</span>
            <div className="flex items-center gap-1">
              <a
                href={tunnelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] flex items-center gap-1"
              >
                web
                <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={handleCopyUrl}
                className="p-0.5 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]"
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

        {/* Env indicator */}
        <span className="text-[var(--cast-text-muted)]">·</span>
        <span className="flex items-center gap-1 text-sm text-[var(--cast-text-muted)]">
          <Cloud className="w-3.5 h-3.5" />
          Container
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action buttons - ghost style */}
        <div className="flex items-center gap-1">
          {/* Pause/Activate button */}
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
                <MessageCircle className="w-4 h-4" />
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
                <MessageCircleOff className="w-4 h-4" />
              )}
              Mute
            </button>
          )}

          {/* Dismiss button */}
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

        {/* Status badge - far right */}
        <span className={cn(
          "px-2 py-0.5 text-xs font-medium",
          stateBadge.colorClass
        )}>
          {stateBadge.label}
        </span>

        {/* Close button */}
        <button
          onClick={onClose}
          className="p-1 text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] hover:bg-[#f5f5f5]"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
