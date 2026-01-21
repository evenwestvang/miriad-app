import { useState, useEffect, useCallback } from 'react'
import { Link2, Unlink, Loader2, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  deriveAppStatus,
  isExpiringSoon,
  startAppConnect,
  disconnectApp,
  isOAuthAppCallback,
  type SecretsMetadata,
} from '../../lib/apps'

interface AppCardProps {
  /** The system.app artifact slug */
  slug: string
  /** Provider ID (e.g., 'github', 'sanity') */
  provider: string
  /** Display name */
  title: string
  /** Description */
  description?: string
  /** Secrets metadata from artifact */
  secrets?: SecretsMetadata
  /** Space ID for OAuth flow */
  spaceId: string
  /** Channel ID containing the artifact */
  channelId: string
  /** Callback when connection status changes */
  onStatusChange?: () => void
  /** Additional className */
  className?: string
}

type UIState = 'idle' | 'connecting' | 'disconnecting'

/**
 * AppCard
 *
 * Displays a system.app artifact with connection status and connect/disconnect actions.
 * Status is derived from the artifact's secrets metadata.
 */
export function AppCard({
  slug,
  provider,
  title,
  description,
  secrets,
  spaceId,
  channelId,
  onStatusChange,
  className,
}: AppCardProps) {
  const [uiState, setUIState] = useState<UIState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  // Derive status from secrets
  const status = deriveAppStatus(secrets)
  const expiringSoon = isExpiringSoon(secrets)

  // Listen for OAuth callback from popup
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!isOAuthAppCallback(event)) return
      if (event.data.slug !== slug) return

      if (event.data.success) {
        setUIState('idle')
        setError(null)
        onStatusChange?.()
      } else {
        setUIState('idle')
        setError(event.data.errorDescription || event.data.error || 'Authorization failed')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [slug, onStatusChange])

  // Handle connect click
  const handleConnect = useCallback(async () => {
    setUIState('connecting')
    setError(null)

    try {
      const { authorizationUrl } = await startAppConnect(provider, {
        spaceId,
        channelId,
        slug,
      })

      // Open OAuth popup
      const popup = window.open(
        authorizationUrl,
        'oauth-app-popup',
        'width=600,height=700,menubar=no,toolbar=no,location=yes'
      )

      if (!popup) {
        throw new Error('Popup blocked. Please allow popups for this site.')
      }

      // Poll for popup close
      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer)
          // If still connecting, user closed popup without completing
          setUIState((current) => (current === 'connecting' ? 'idle' : current))
        }
      }, 500)
    } catch (err) {
      setUIState('idle')
      setError(err instanceof Error ? err.message : 'Failed to start connection')
    }
  }, [provider, spaceId, channelId, slug])

  // Handle disconnect click
  const handleDisconnect = useCallback(async () => {
    setUIState('disconnecting')
    setError(null)
    setShowDisconnectConfirm(false)

    try {
      await disconnectApp(provider, { spaceId, channelId, slug })
      setUIState('idle')
      onStatusChange?.()
    } catch (err) {
      setUIState('idle')
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }, [provider, spaceId, channelId, slug, onStatusChange])

  // Format expiry time
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

  const isConnected = status === 'connected'
  const isExpired = status === 'expired'
  const isLoading = uiState === 'connecting' || uiState === 'disconnecting'

  return (
    <div
      className={cn(
        'border border-border rounded-lg p-4 bg-card',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-medium text-base text-foreground">{title}</h3>
          {description && (
            <p className="text-base text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>

        {/* Status badge */}
        <div
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 text-base rounded',
            isConnected && !expiringSoon && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            isConnected && expiringSoon && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            isExpired && 'bg-red-500/10 text-red-600 dark:text-red-400',
            !isConnected && !isExpired && 'bg-secondary text-muted-foreground'
          )}
        >
          {isConnected && !expiringSoon && <CheckCircle className="w-3.5 h-3.5" />}
          {isConnected && expiringSoon && <AlertTriangle className="w-3.5 h-3.5" />}
          {isExpired && <AlertTriangle className="w-3.5 h-3.5" />}
          {!isConnected && !isExpired && <Link2 className="w-3.5 h-3.5" />}

          <span>
            {isConnected && !expiringSoon && 'Connected'}
            {isConnected && expiringSoon && 'Expiring soon'}
            {isExpired && 'Expired'}
            {!isConnected && !isExpired && 'Not connected'}
          </span>

          {isConnected && secrets?.accessToken?.expiresAt && (
            <span className="text-muted-foreground ml-1">
              ({formatExpiry(secrets.accessToken.expiresAt)})
            </span>
          )}
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-start gap-2 p-2 mb-3 bg-destructive/10 border border-destructive/20 rounded text-base text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Connect / Reconnect button */}
        {(!isConnected || isExpired || expiringSoon) && (
          <button
            onClick={handleConnect}
            disabled={isLoading}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-base rounded font-medium transition-colors',
              isLoading
                ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {uiState === 'connecting' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Connecting...
              </>
            ) : isConnected && expiringSoon ? (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                Reconnect
              </>
            ) : (
              <>
                <Link2 className="w-3.5 h-3.5" />
                Connect
              </>
            )}
          </button>
        )}

        {/* Disconnect button */}
        {isConnected && !showDisconnectConfirm && (
          <button
            onClick={() => setShowDisconnectConfirm(true)}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-1.5 text-base rounded hover:bg-secondary/50 text-muted-foreground transition-colors"
          >
            <Unlink className="w-3.5 h-3.5" />
            Disconnect
          </button>
        )}

        {/* Disconnect confirmation */}
        {showDisconnectConfirm && (
          <div className="flex items-center gap-1">
            <span className="text-base text-muted-foreground mr-1">Disconnect?</span>
            <button
              onClick={handleDisconnect}
              disabled={isLoading}
              className="px-2 py-1 text-base rounded font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uiState === 'disconnecting' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                'Yes'
              )}
            </button>
            <button
              onClick={() => setShowDisconnectConfirm(false)}
              disabled={isLoading}
              className="px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
