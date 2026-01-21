import { useEffect, useState } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'

/**
 * OAuthCallbackPage - Success page for OAuth app connection
 *
 * This page is loaded in a popup after successful OAuth callback.
 * It posts a message to the parent window and auto-closes.
 *
 * Query params:
 * - app: artifact slug
 * - connected: 'true' if connection succeeded
 */
export function OAuthCallbackPage() {
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const slug = params.get('app')
    const connected = params.get('connected') === 'true'

    if (connected && slug) {
      // Post success message to parent window (same-origin)
      if (window.opener) {
        window.opener.postMessage({
          type: 'oauth-app-callback',
          success: true,
          provider: '', // Backend doesn't include this, but slug is enough
          slug,
        }, window.location.origin)
      }

      // Auto-close after brief delay
      setClosing(true)
      setTimeout(() => {
        window.close()
      }, 1500)
    }
  }, [])

  const handleClose = () => {
    window.close()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full text-center space-y-4">
        {closing ? (
          <>
            <div className="flex justify-center">
              <CheckCircle className="w-12 h-12 text-emerald-500" />
            </div>
            <h1 className="text-lg font-semibold text-foreground">Connected!</h1>
            <p className="text-base text-muted-foreground">
              This window will close automatically...
            </p>
            <div className="flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
            <p className="text-base text-muted-foreground">
              Completing connection...
            </p>
          </>
        )}

        <button
          onClick={handleClose}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Close window
        </button>
      </div>
    </div>
  )
}
