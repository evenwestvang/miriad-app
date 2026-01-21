import { useEffect, useRef, useState } from 'react'
import { X, Copy, Check, Globe } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getSenderColor } from '../../utils'
import type { RosterAgent } from './MentionAutocomplete'

// Tunnel domain from environment, defaults to production
const TUNNEL_DOMAIN = import.meta.env.VITE_TUNNEL_DOMAIN || 'cast-stack.site'

interface AgentDetailPopupProps {
  /** Agent to display details for */
  agent: RosterAgent
  /** Called when popup is closed */
  onClose: () => void
  /** Whether popup is open */
  isOpen: boolean
  /** Position relative to trigger button (bottom = distance from viewport bottom) */
  position?: { bottom: number; left: number }
}

/**
 * Popup showing agent details including tunnel URL.
 * Opens when clicking on an agent badge in the roster.
 */
export function AgentDetailPopup({
  agent,
  onClose,
  isOpen,
  position,
}: AgentDetailPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // Construct tunnel URL from hash
  const tunnelUrl = agent.tunnelHash
    ? `https://${agent.tunnelHash}.${TUNNEL_DOMAIN}`
    : null

  // Tunnel is connected if agent is online
  const isTunnelConnected = agent.isOnline

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    // Small delay to prevent immediate close from same click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

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

  if (!isOpen) return null

  // Derive status display from isOnline/isWorking
  const status = !agent.isOnline
    ? { label: 'Offline', color: 'bg-gray-500' }
    : agent.isWorking
      ? { label: 'Working', color: 'bg-blue-500 animate-pulse' }
      : { label: 'Idle', color: 'bg-green-500' }

  return (
    <div
      ref={popupRef}
      className="fixed z-50 bg-card border border-border rounded-lg shadow-lg w-72"
      style={position ? { bottom: position.bottom, left: position.left } : undefined}
    >
      {/* Header */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <span className={cn("font-medium text-base", getSenderColor(agent.callsign))}>
            @{agent.callsign}
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-3 space-y-3">
        {/* Agent Status */}
        <div className="flex items-center gap-2 text-base">
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0", status.color)} />
          <span className="text-muted-foreground">Status:</span>
          <span>{status.label}</span>
        </div>

        {/* Session Cost */}
        {agent.sessionCost !== undefined && agent.sessionCost > 0 && (
          <div className="flex items-center gap-2 text-base">
            <span className="text-muted-foreground">Session cost:</span>
            <span className="font-mono">
              ${agent.sessionCost < 0.01 ? agent.sessionCost.toFixed(4) : agent.sessionCost.toFixed(2)}
            </span>
          </div>
        )}

        {/* Tunnel Section */}
        {tunnelUrl ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <Globe className="w-3 h-3" />
              Tunnel
            </div>

            {/* URL with copy button */}
            <div className="flex items-center gap-2 p-2 bg-secondary/30 rounded text-xs font-mono">
              <span className="flex-1 truncate" title={tunnelUrl}>
                {tunnelUrl}
              </span>
              <button
                onClick={handleCopyUrl}
                className="p-1 rounded hover:bg-secondary/50 text-muted-foreground flex-shrink-0"
                title="Copy URL"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-green-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {/* Connection status */}
            <div className="flex items-center gap-2 text-xs">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                isTunnelConnected ? "bg-green-500" : "bg-gray-500"
              )} />
              <span className="text-muted-foreground">
                {isTunnelConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            {/* Helper text */}
            <p className="text-xs text-muted-foreground">
              Any port bound to 0.0.0.0 is reachable at this hostname.
            </p>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            No tunnel configured for this agent.
          </div>
        )}
      </div>
    </div>
  )
}
