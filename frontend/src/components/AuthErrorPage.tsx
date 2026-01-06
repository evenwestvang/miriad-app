/**
 * Auth Error Page
 *
 * Displays authentication errors from the OAuth flow.
 * Backend redirects here with ?error=<error_code> query param.
 */

import { AlertCircle, ArrowLeft } from 'lucide-react'

interface AuthErrorPageProps {
  /** Error code from query params */
  error: string | null
  /** Callback to retry login */
  onRetry: () => void
}

/**
 * Map error codes to user-friendly messages
 */
function getErrorMessage(error: string | null): { title: string; description: string } {
  switch (error) {
    case 'missing_code':
      return {
        title: 'Authentication Failed',
        description: 'The authentication response was missing required data. Please try again.',
      }
    case 'callback_failed':
      return {
        title: 'Authentication Failed',
        description: 'There was a problem completing the sign-in process. Please try again.',
      }
    case 'no_space':
      return {
        title: 'Account Setup Incomplete',
        description: 'Your account exists but no workspace was found. Please contact support.',
      }
    default:
      return {
        title: 'Authentication Error',
        description: error
          ? `An error occurred during sign-in: ${error}`
          : 'An unexpected error occurred during sign-in. Please try again.',
      }
  }
}

export function AuthErrorPage({ error, onRetry }: AuthErrorPageProps) {
  const { title, description } = getErrorMessage(error)

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Error Icon */}
        <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>

        {/* Error Message */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={onRetry}
            className="w-full py-3 px-6 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="w-full py-3 px-6 bg-secondary text-secondary-foreground rounded-lg font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </button>
        </div>

        {/* Help text */}
        <p className="text-xs text-muted-foreground">
          If this problem persists, please contact support.
        </p>
      </div>
    </div>
  )
}
