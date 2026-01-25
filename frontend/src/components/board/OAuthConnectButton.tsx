import { useState, useEffect, useCallback } from 'react'
import { Link2, Unlink, Loader2, AlertTriangle, CheckCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * OAuth connection status
 */
export type OAuthStatus = 'not_connected' | 'connecting' | 'connected' | 'error' | 'expiring_soon'

/**
 * OAuth status response from the server
 */
interface OAuthStatusResponse {
  status: 'connected' | 'disconnected' | 'expired'
  expiresAt?: string
  scopes?: string[]
}

/**
 * OAuth start response from the server
 */
interface OAuthStartResponse {
  authorizationUrl: string
  state: string
}

interface OAuthConnectButtonProps {
  /** Channel containing the MCP artifact */
  channel: string
  /** The system.mcp artifact slug */
  mcpSlug: string
  /** Base URL for API calls (defaults to current origin) */
  baseUrl?: string
  /** Callback when connection status changes */
  onStatusChange?: (status: OAuthStatus) => void
  /** Additional className */
  className?: string
}

/** Threshold for "expiring soon" warning (24 hours) */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000

/**
 * Fetch OAuth connection status from the server
 */
async function fetchOAuthStatus(
  baseUrl: string,
  channel: string,
  mcpSlug: string
): Promise<OAuthStatusResponse> {
  const params = new URLSearchParams({ channel, mcpSlug })
  const response = await fetch(`${baseUrl}/api/oauth/status?${params}`, {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth status: ${response.status}`)
  }
  return response.json()
}

/**
 * Start OAuth flow and get authorization URL
 */
async function startOAuthFlow(
  baseUrl: string,
  channel: string,
  mcpSlug: string
): Promise<OAuthStartResponse> {
  const response = await fetch(`${baseUrl}/api/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, mcpSlug }),
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to start OAuth flow: ${response.status}`)
  }
  return response.json()
}

/**
 * Disconnect OAuth (clear tokens)
 */
async function disconnectOAuth(
  baseUrl: string,
  channel: string,
  mcpSlug: string
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/oauth/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, mcpSlug }),
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to disconnect OAuth: ${response.status}`)
  }
}

/**
 * Derive UI status from server response
 */
function deriveOAuthStatus(response: OAuthStatusResponse): OAuthStatus {
  if (response.status === 'disconnected') {
    return 'not_connected'
  }
  if (response.status === 'expired') {
    return 'not_connected' // Treat expired as needing reconnection
  }
  if (response.status === 'connected') {
    // Check if expiring soon
    if (response.expiresAt) {
      const expiresAt = new Date(response.expiresAt).getTime()
      if (expiresAt - Date.now() < EXPIRING_SOON_MS) {
        return 'expiring_soon'
      }
    }
    return 'connected'
  }
  return 'not_connected'
}

/**
 * OAuth Connect Button
 *
 * Handles OAuth connection flow for HTTP MCP servers.
 * Uses popup-based OAuth with postMessage callback.
 */
export function OAuthConnectButton({
  channel,
  mcpSlug,
  baseUrl = '',
  onStatusChange,
  className,
}: OAuthConnectButtonProps) {
  const [status, setStatus] = useState<OAuthStatus>('not_connected')
  const [error, setError] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  // Update status and notify parent
  const updateStatus = useCallback(
    (newStatus: OAuthStatus) => {
      setStatus(newStatus)
      onStatusChange?.(newStatus)
    },
    [onStatusChange]
  )

  // Fetch initial status
  useEffect(() => {
    let mounted = true

    async function checkStatus() {
      try {
        const response = await fetchOAuthStatus(baseUrl, channel, mcpSlug)
        if (!mounted) return

        const derivedStatus = deriveOAuthStatus(response)
        updateStatus(derivedStatus)
        setExpiresAt(response.expiresAt ?? null)
        setError(null)
      } catch (err) {
        if (!mounted) return
        console.error('[OAuthConnectButton] Failed to fetch status:', err)
        updateStatus('error')
        setError(err instanceof Error ? err.message : 'Failed to check status')
      }
    }

    checkStatus()

    return () => {
      mounted = false
    }
  }, [baseUrl, channel, mcpSlug, updateStatus])

  // Listen for OAuth callback postMessage
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Verify origin matches
      if (baseUrl && event.origin !== new URL(baseUrl, window.location.origin).origin) {
        return
      }

      const data = event.data
      if (data?.type !== 'oauth-callback') return

      if (data.success) {
        updateStatus('connected')
        setError(null)
        // Refetch to get expiry info
        fetchOAuthStatus(baseUrl, channel, mcpSlug)
          .then((response) => {
            setExpiresAt(response.expiresAt ?? null)
          })
          .catch(() => {
            // Ignore - we already know we're connected
          })
      } else {
        updateStatus('error')
        setError(data.errorDescription || data.error || 'Authorization failed')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [baseUrl, channel, mcpSlug, updateStatus])

  // Handle connect click
  const handleConnect = async () => {
    try {
      updateStatus('connecting')
      setError(null)

      const { authorizationUrl } = await startOAuthFlow(baseUrl, channel, mcpSlug)

      // Open popup for OAuth flow
      const popup = window.open(
        authorizationUrl,
        'oauth-popup',
        'width=600,height=700,menubar=no,toolbar=no,location=yes'
      )

      if (!popup) {
        throw new Error('Popup blocked. Please allow popups for this site.')
      }

      // Poll to detect if popup was closed without completing
      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer)
          // If still connecting, user closed the popup
          if (status === 'connecting') {
            updateStatus('not_connected')
          }
        }
      }, 500)
    } catch (err) {
      console.error('[OAuthConnectButton] Connect failed:', err)
      updateStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to start connection')
    }
  }

  // Handle disconnect click
  const handleDisconnect = async () => {
    try {
      await disconnectOAuth(baseUrl, channel, mcpSlug)
      updateStatus('not_connected')
      setExpiresAt(null)
      setError(null)
      setShowDisconnectConfirm(false)
    } catch (err) {
      console.error('[OAuthConnectButton] Disconnect failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  // Format expiry time for display
  const formatExpiry = (isoString: string): string => {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = date.getTime() - now.getTime()

    if (diffMs <= 0) return 'Expired'

    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d remaining`
    if (hours > 0) return `${hours}h remaining`
    return 'Expires soon'
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* Status indicator and action button */}
      <div className="flex items-center gap-2">
        {/* Connect button */}
        {(status === 'not_connected' || status === 'error') && (
          <button
            onClick={handleConnect}
            className="flex items-center gap-1.5 px-3 py-1.5 text-base rounded font-medium bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Link2 className="w-3.5 h-3.5" />
            Connect
          </button>
        )}

        {/* Connecting state */}
        {status === 'connecting' && (
          <button
            disabled
            className="flex items-center gap-1.5 px-3 py-1.5 text-base rounded font-medium bg-secondary text-muted-foreground cursor-not-allowed"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Connecting...
          </button>
        )}

        {/* Connected state */}
        {(status === 'connected' || status === 'expiring_soon') && (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 text-base rounded',
                status === 'expiring_soon'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              )}
            >
              {status === 'expiring_soon' ? (
                <AlertTriangle className="w-3.5 h-3.5" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5" />
              )}
              Connected
              {expiresAt && (
                <span className="text-muted-foreground ml-1">
                  ({formatExpiry(expiresAt)})
                </span>
              )}
            </span>

            {/* Disconnect button */}
            {showDisconnectConfirm ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleDisconnect}
                  className="px-2 py-1 text-base rounded font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowDisconnectConfirm(false)}
                  className="px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="flex items-center gap-1 px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground"
                title="Disconnect OAuth"
              >
                <Unlink className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-start gap-2 p-2 bg-destructive/10 border border-destructive/20 rounded text-base text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Expiring soon warning */}
      {status === 'expiring_soon' && !error && (
        <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-base text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Token expiring soon. Click "Connect" to refresh your authorization.
          </span>
        </div>
      )}
    </div>
  )
}
