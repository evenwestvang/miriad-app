import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Loader2, CheckCircle2, AlertCircle, Clock, ExternalLink, Circle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  OAuthStatus,
  OAuthStatusResponse,
  fetchOAuthStatus,
  startOAuthFlow,
  disconnectOAuth,
  deriveOAuthStatus,
} from '@/api'

interface OAuthConnectButtonProps {
  channel: string
  mcpSlug: string
  mcpTitle?: string // Display name for the MCP
  className?: string
}

// State machine per @finch's UX spec
type ConnectionState =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnecting'

type ErrorType =
  | 'popup_blocked'
  | 'access_denied'
  | 'network_error'
  | 'token_exchange_failed'
  | 'popup_closed'
  | null

interface OAuthCallbackMessage {
  type: 'oauth-callback'
  success: boolean
  mcpSlug: string
  channel: string
  error?: string
  errorDescription?: string
}

// Global popup reference to enforce one-popup-at-a-time
let activePopup: Window | null = null

const STATUS_CONFIG: Record<OAuthStatus, {
  icon: typeof CheckCircle2
  label: string
  color: string
  bgColor: string
}> = {
  connected: {
    icon: CheckCircle2,
    label: 'Connected',
    color: 'text-green-600',
    bgColor: 'bg-green-50 dark:bg-green-950/30',
  },
  expiring_soon: {
    icon: Clock,
    label: 'Session expires soon',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-50 dark:bg-yellow-950/30',
  },
  expired: {
    icon: AlertCircle,
    label: 'Session expired',
    color: 'text-red-600',
    bgColor: 'bg-red-50 dark:bg-red-950/30',
  },
  disconnected: {
    icon: Circle,
    label: 'Not connected',
    color: 'text-muted-foreground',
    bgColor: 'bg-secondary/30',
  },
}

const ERROR_MESSAGES: Record<NonNullable<ErrorType>, { title: string; description: string }> = {
  popup_blocked: {
    title: 'Popup was blocked',
    description: 'Your browser blocked the authorization window. Click below to try again or open manually.',
  },
  access_denied: {
    title: 'Authorization denied',
    description: 'You declined access. Click Connect to try again if this was a mistake.',
  },
  network_error: {
    title: 'Connection failed',
    description: 'Could not complete authorization. Please check your connection and try again.',
  },
  token_exchange_failed: {
    title: 'Authorization failed',
    description: 'Something went wrong during setup. Please try again. If this persists, contact support.',
  },
  popup_closed: {
    title: 'Authorization window was closed',
    description: '',
  },
}

export function OAuthConnectButton({ channel, mcpSlug, mcpTitle, className }: OAuthConnectButtonProps) {
  const [statusResponse, setStatusResponse] = useState<OAuthStatusResponse>({ status: 'disconnected' })
  const [connectionState, setConnectionState] = useState<ConnectionState>('not_connected')
  const [errorType, setErrorType] = useState<ErrorType>(null)
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)

  const popupRef = useRef<Window | null>(null)
  const popupCheckInterval = useRef<NodeJS.Timeout | null>(null)

  // Derive UI status from backend response (adds 'expiring_soon' if within 24h)
  const uiStatus = deriveOAuthStatus(statusResponse)

  // Fetch initial status
  useEffect(() => {
    fetchOAuthStatus(channel, mcpSlug)
      .then((res) => {
        setStatusResponse(res)
        const derived = deriveOAuthStatus(res)
        setConnectionState(derived === 'connected' || derived === 'expiring_soon' ? 'connected' : 'not_connected')
      })
      .catch(() => {
        setStatusResponse({ status: 'disconnected' })
        setConnectionState('not_connected')
      })
  }, [channel, mcpSlug])

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin (should match our server)
      if (event.origin !== window.location.origin) return

      const data = event.data as OAuthCallbackMessage
      if (data?.type !== 'oauth-callback' || data.mcpSlug !== mcpSlug || data.channel !== channel) return

      // Clear popup monitoring
      if (popupCheckInterval.current) {
        clearInterval(popupCheckInterval.current)
        popupCheckInterval.current = null
      }
      popupRef.current = null
      activePopup = null

      if (data.success) {
        setStatusResponse({ status: 'connected' })
        setConnectionState('connected')
        setErrorType(null)
      } else {
        // Map backend error codes to UI error types
        const errorMap: Record<string, ErrorType> = {
          'access_denied': 'access_denied',
          'network_error': 'network_error',
          'token_exchange_failed': 'token_exchange_failed',
        }
        setErrorType(data.error ? (errorMap[data.error] || 'network_error') : 'network_error')
        setConnectionState('error')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [mcpSlug, channel])

  // Monitor popup for early close
  useEffect(() => {
    if (connectionState !== 'connecting' || !popupRef.current) return

    popupCheckInterval.current = setInterval(() => {
      if (popupRef.current?.closed) {
        // Popup was closed - check if we got a postMessage
        // If not, fall back to polling status once
        clearInterval(popupCheckInterval.current!)
        popupCheckInterval.current = null

        // Give postMessage 2 seconds to arrive (per @finch's spec)
        setTimeout(async () => {
          // If still connecting, popup was closed without completing
          if (connectionState === 'connecting') {
            // Fallback: poll status once
            try {
              const newStatus = await fetchOAuthStatus(channel, mcpSlug)
              if (newStatus.status === 'connected') {
                setStatusResponse(newStatus)
                setConnectionState('connected')
                return
              }
            } catch {
              // Ignore
            }
            // Popup closed without completing
            setConnectionState('not_connected')
            // Don't show error for user-initiated close (per spec: "no error styling")
          }
        }, 2000)

        popupRef.current = null
        activePopup = null
      }
    }, 500)

    return () => {
      if (popupCheckInterval.current) {
        clearInterval(popupCheckInterval.current)
      }
    }
  }, [connectionState, channel, mcpSlug])

  const handleConnect = useCallback(async () => {
    // One popup at a time (per @finch's spec)
    if (activePopup && !activePopup.closed) {
      activePopup.focus()
      return
    }

    setErrorType(null)
    setConnectionState('connecting')

    try {
      const { authorizationUrl } = await startOAuthFlow(channel, mcpSlug)
      setAuthUrl(authorizationUrl)

      // Open OAuth flow in popup
      const popup = window.open(
        authorizationUrl,
        'oauth',
        'width=600,height=700,menubar=no,toolbar=no,location=yes,status=yes'
      )

      if (popup) {
        popupRef.current = popup
        activePopup = popup
        popup.focus()
      } else {
        // Popup blocked
        setErrorType('popup_blocked')
        setConnectionState('error')
      }
    } catch (err) {
      setErrorType('network_error')
      setConnectionState('error')
    }
  }, [channel, mcpSlug])

  const handleCancel = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close()
    }
    if (popupCheckInterval.current) {
      clearInterval(popupCheckInterval.current)
      popupCheckInterval.current = null
    }
    popupRef.current = null
    activePopup = null
    setConnectionState('not_connected')
    setErrorType(null)
  }, [])

  const handleDisconnect = useCallback(async () => {
    setShowDisconnectDialog(false)
    setConnectionState('disconnecting')

    try {
      await disconnectOAuth(channel, mcpSlug)
      setStatusResponse({ status: 'disconnected' })
      setConnectionState('not_connected')
      setErrorType(null)
    } catch {
      setErrorType('network_error')
      setConnectionState('error')
    }
  }, [channel, mcpSlug])

  const handleOpenInNewTab = useCallback(() => {
    if (authUrl) {
      window.open(authUrl, '_blank')
      setConnectionState('connecting')
      setErrorType(null)
    }
  }, [authUrl])

  const handleRetry = useCallback(() => {
    setErrorType(null)
    handleConnect()
  }, [handleConnect])

  const handleDismissError = useCallback(() => {
    setErrorType(null)
    setConnectionState('not_connected')
  }, [])

  const config = STATUS_CONFIG[uiStatus]
  const StatusIcon = config.icon
  const isConnected = connectionState === 'connected'
  const isConnecting = connectionState === 'connecting'
  const isDisconnecting = connectionState === 'disconnecting'
  const hasError = connectionState === 'error' && errorType
  const errorInfo = errorType ? ERROR_MESSAGES[errorType] : null

  const displayName = mcpTitle || mcpSlug

  return (
    <div className={cn('space-y-2', className)}>
      {/* Status indicator */}
      <div className={cn('flex items-center gap-2 px-3 py-2 rounded-md', config.bgColor)}>
        {isConnecting || isDisconnecting ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <StatusIcon className={cn('h-4 w-4', config.color)} />
        )}
        <div className="flex-1 min-w-0">
          <span className={cn('text-sm font-medium', config.color)}>
            {isConnecting ? 'Connecting...' : isDisconnecting ? 'Disconnecting...' : config.label}
          </span>
          {isConnecting && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Complete authorization in the popup
            </p>
          )}
          {statusResponse.scopes && statusResponse.scopes.length > 0 && isConnected && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Scopes: {statusResponse.scopes.join(', ')}
            </p>
          )}
        </div>
        {statusResponse.expiresAt && isConnected && (
          <span className="text-xs text-muted-foreground">
            Expires {new Date(statusResponse.expiresAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Error message */}
      {hasError && errorInfo && errorInfo.title && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-3 py-2">
          <p className="text-sm font-medium text-red-600">{errorInfo.title}</p>
          {errorInfo.description && (
            <p className="text-xs text-red-600/80 mt-1">{errorInfo.description}</p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {isConnecting ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
          >
            Cancel
          </Button>
        ) : isConnected ? (
          <>
            {uiStatus === 'expiring_soon' && (
              <Button
                variant="default"
                size="sm"
                onClick={handleConnect}
              >
                Reconnect
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDisconnectDialog(true)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              Disconnect
            </Button>
          </>
        ) : hasError && errorType === 'popup_blocked' ? (
          <>
            <Button
              variant="default"
              size="sm"
              onClick={handleRetry}
            >
              Try Again
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenInNewTab}
            >
              <ExternalLink className="h-4 w-4 mr-1" />
              Open in New Tab
            </Button>
          </>
        ) : hasError ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleRetry}
          >
            Try Again
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={handleConnect}
            disabled={isDisconnecting}
          >
            Connect
          </Button>
        )}
      </div>

      {/* Disconnect confirmation dialog */}
      <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect from {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your agents will lose access to {displayName} tools until you reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              className="bg-red-600 hover:bg-red-700"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
