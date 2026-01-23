import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import {
  fetchAvailableApps,
  startAppConnect,
  isOAuthAppCallback,
  type AppDefinition,
} from '../../lib/apps'

interface AddAppModalProps {
  isOpen: boolean
  onClose: () => void
  /** Space ID for OAuth flow */
  spaceId: string
  /** Channel ID where the app will be added */
  channelId: string
  /** Called after app is successfully added and connected */
  onSuccess: (slug: string) => void
}

type ModalState = 'loading' | 'selecting' | 'connecting' | 'error'

/**
 * AddAppModal
 *
 * Modal for adding a new app integration:
 * 1. Fetches available apps from registry
 * 2. User selects a provider
 * 3. Creates system.app artifact
 * 4. Initiates OAuth flow
 */
export function AddAppModal({
  isOpen,
  onClose,
  spaceId,
  channelId,
  onSuccess,
}: AddAppModalProps) {
  const [state, setState] = useState<ModalState>('loading')
  const [apps, setApps] = useState<AppDefinition[]>([])
  const [selectedApp, setSelectedApp] = useState<AppDefinition | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch available apps when modal opens
  useEffect(() => {
    if (!isOpen) return

    setState('loading')
    setError(null)
    setSelectedApp(null)

    fetchAvailableApps()
      .then((apps) => {
        setApps(apps)
        setState('selecting')
      })
      .catch((err) => {
        setError(err.message || 'Failed to load available apps')
        setState('error')
      })
  }, [isOpen])

  // Listen for OAuth callback
  useEffect(() => {
    if (!isOpen || !selectedApp) return

    function handleMessage(event: MessageEvent) {
      if (!isOAuthAppCallback(event)) return
      if (event.data.provider !== selectedApp?.id) return

      if (event.data.success) {
        onSuccess(event.data.slug)
        handleClose()
      } else {
        setError(event.data.errorDescription || event.data.error || 'Authorization failed')
        setState('selecting')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [isOpen, selectedApp, onSuccess])

  const handleClose = useCallback(() => {
    setState('loading')
    setApps([])
    setSelectedApp(null)
    setError(null)
    onClose()
  }, [onClose])

  const handleSelectApp = useCallback(
    async (app: AppDefinition) => {
      setSelectedApp(app)
      setState('connecting')
      setError(null)

      try {
        // First, create the system.app artifact
        const slug = app.id // Use provider ID as slug (e.g., 'github')

        const createResponse = await apiFetch(`/channels/${channelId}/artifacts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug,
            type: 'system.app',
            title: app.name,
            tldr: app.description,
            content: `# ${app.name}\n\n${app.description}`,
            status: 'active',
            props: {
              provider: app.id,
            },
            sender: 'user',
          }),
        })

        // 409 means artifact already exists - that's okay, we'll just connect
        if (!createResponse.ok && createResponse.status !== 409) {
          const data = await createResponse.json().catch(() => ({}))
          throw new Error(data.error || 'Failed to create app artifact')
        }

        // Now initiate OAuth
        const { authorizationUrl } = await startAppConnect(app.id, {
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
            setState((current) => {
              if (current === 'connecting') {
                setSelectedApp(null)
                return 'selecting'
              }
              return current
            })
          }
        }, 500)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add app')
        setState('selecting')
        setSelectedApp(null)
      }
    },
    [spaceId, channelId]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    },
    [handleClose]
  )

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Modal */}
      <div
        className="relative bg-card border border-border rounded-lg w-[480px] max-h-[90vh] overflow-hidden shadow-lg"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Add App</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {/* Error display */}
          {error && (
            <div className="flex items-start gap-2 p-3 mb-4 bg-destructive/10 border border-destructive/20 rounded-md text-base text-destructive">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Error</p>
                <p className="text-base mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Loading state */}
          {state === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-base text-muted-foreground">
                Loading available apps...
              </span>
            </div>
          )}

          {/* Error state */}
          {state === 'error' && (
            <div className="flex flex-col items-center justify-center py-12">
              <AlertTriangle className="w-8 h-8 text-destructive mb-2" />
              <p className="text-base text-muted-foreground">Failed to load apps</p>
              <button
                onClick={() => {
                  setState('loading')
                  setError(null)
                  fetchAvailableApps()
                    .then((apps) => {
                      setApps(apps)
                      setState('selecting')
                    })
                    .catch((err) => {
                      setError(err.message)
                      setState('error')
                    })
                }}
                className="mt-3 px-3 py-1.5 text-base rounded bg-secondary text-foreground hover:bg-secondary/80"
              >
                Retry
              </button>
            </div>
          )}

          {/* Connecting state */}
          {state === 'connecting' && selectedApp && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary mb-3" />
              <p className="text-base font-medium text-foreground">
                Connecting to {selectedApp.name}
              </p>
              <p className="text-base text-muted-foreground mt-1">
                Complete authorization in the popup window
              </p>
              <button
                onClick={() => {
                  setState('selecting')
                  setSelectedApp(null)
                }}
                className="mt-4 px-3 py-1.5 text-base rounded bg-secondary text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}

          {/* App selection */}
          {state === 'selecting' && (
            <>
              <p className="text-base text-muted-foreground mb-4">
                Connect an external service to give your agents new capabilities.
              </p>

              <div className="space-y-2">
                {apps.map((app) => (
                  <button
                    key={app.id}
                    onClick={() => handleSelectApp(app)}
                    className={cn(
                      'w-full flex items-start gap-3 p-3 rounded-lg border border-border',
                      'hover:border-primary/50 hover:bg-secondary/30 transition-colors text-left'
                    )}
                  >
                    {/* App icon placeholder */}
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
                      {app.icon ? (
                        <img src={app.icon} alt="" className="w-6 h-6" />
                      ) : (
                        <ExternalLink className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-base text-foreground">
                        {app.name}
                      </h3>
                      <p className="text-base text-muted-foreground mt-0.5 line-clamp-2">
                        {app.description}
                      </p>
                      {app.scopes.length > 0 && (
                        <p className="text-base text-muted-foreground/60 mt-1">
                          Scopes: {app.scopes.join(', ')}
                        </p>
                      )}
                    </div>
                  </button>
                ))}

                {apps.length === 0 && (
                  <p className="text-base text-muted-foreground text-center py-8">
                    No apps available yet.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
