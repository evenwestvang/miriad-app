/**
 * Landing Page
 *
 * Simple landing page with login button.
 * Placeholder for marketing content later.
 */

import { API_HOST } from '../lib/api'

interface LandingPageProps {
  /** Callback when login is triggered */
  onLogin?: () => void
}

export function LandingPage({ onLogin }: LandingPageProps) {
  const handleLogin = () => {
    if (onLogin) {
      onLogin()
    }
    // Redirect to OAuth login endpoint (backend handles provider routing)
    window.location.href = `${API_HOST}/auth/login`
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Logo / Brand */}
        <div className="space-y-2">
          <h1 className="text-4xl font-bold text-foreground">Cikada</h1>
          <p className="text-muted-foreground">
            Multi-agent collaboration workspace
          </p>
        </div>

        {/* Placeholder for marketing content */}
        <div className="space-y-4 py-8">
          <div className="text-base text-muted-foreground">
            Orchestrate AI agents to work together on complex tasks.
          </div>
        </div>

        {/* Login Button */}
        <button
          onClick={handleLogin}
          className="w-full py-3 px-6 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
        >
          Sign In
        </button>

        {/* Footer */}
        <p className="text-xs text-muted-foreground pt-8">
          By logging in, you agree to our terms of service.
        </p>
      </div>
    </div>
  )
}
