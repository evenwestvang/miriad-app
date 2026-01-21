import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

/**
 * OAuthErrorPage - Error page for failed OAuth app connection
 *
 * This page is loaded in a popup when OAuth callback fails.
 * It shows the error message and posts to parent window.
 *
 * Query params:
 * - error: error code
 * - description: human-readable error description
 */
export function OAuthErrorPage() {
  const [error, setError] = useState<string>('')
  const [description, setDescription] = useState<string>('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const errorCode = params.get('error') || 'unknown_error'
    const errorDesc = params.get('description') || getDefaultDescription(errorCode)

    setError(errorCode)
    setDescription(errorDesc)

    // Post error message to parent window (same-origin)
    if (window.opener) {
      window.opener.postMessage({
        type: 'oauth-app-callback',
        success: false,
        provider: '',
        slug: '',
        error: errorCode,
        errorDescription: errorDesc,
      }, window.location.origin)
    }
  }, [])

  const handleClose = () => {
    window.close()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full">
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-red-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold text-foreground">
                Connection Failed
              </h1>
              <p className="text-base text-muted-foreground mt-1">
                {description}
              </p>
            </div>
          </div>

          {/* Error code */}
          <div className="bg-secondary/50 rounded px-3 py-2">
            <span className="text-xs font-mono text-muted-foreground">
              Error: {error}
            </span>
          </div>

          {/* Actions */}
          <div className="flex justify-end">
            <button
              onClick={handleClose}
              className="flex items-center gap-2 px-4 py-2 text-base font-medium rounded bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
              Close
            </button>
          </div>
        </div>

        {/* Footer hint */}
        <p className="text-xs text-muted-foreground text-center mt-4">
          You can try connecting again from the app settings.
        </p>
      </div>
    </div>
  )
}

/**
 * Get default description for common error codes
 */
function getDefaultDescription(error: string): string {
  const descriptions: Record<string, string> = {
    access_denied: 'You denied access to the application.',
    invalid_request: 'The authorization request was invalid.',
    unauthorized_client: 'The client is not authorized.',
    unsupported_response_type: 'The authorization server does not support this response type.',
    invalid_scope: 'The requested scope is invalid or unknown.',
    server_error: 'The authorization server encountered an error.',
    temporarily_unavailable: 'The server is temporarily unavailable. Please try again later.',
    token_exchange_failed: 'Failed to complete the authorization. Please try again.',
    missing_state: 'Authorization state was missing or invalid.',
    invalid_state: 'Authorization state verification failed.',
  }

  return descriptions[error] || 'An unexpected error occurred during authorization.'
}
