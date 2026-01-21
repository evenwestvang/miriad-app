/**
 * Onboarding Page (WorkOS OAuth)
 *
 * Shown to first-time users after OAuth authentication.
 * They pick their callsign and space name before being fully logged in.
 */

import { useState, useEffect } from 'react'
import { User, Loader2, Sparkles } from 'lucide-react'

interface OnboardingPageProps {
  /** Pre-filled name suggestion from WorkOS (e.g., user's first name) */
  suggestedName?: string
  /** The onboarding token from the URL */
  onboardingToken: string
  /** Called after successful onboarding */
  onComplete: (userId: string, spaceId: string) => void
  /** API host for backend calls */
  apiHost: string
}

/**
 * Generate a callsign suggestion from a name.
 * Converts to lowercase, removes special chars, takes first word.
 */
function suggestCallsign(name?: string): string {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)[0]
    .slice(0, 20)
}

export function OnboardingPage({
  suggestedName,
  onboardingToken,
  onComplete,
  apiHost,
}: OnboardingPageProps) {
  // Form state
  const [callsign, setCallsign] = useState(() => suggestCallsign(suggestedName))
  const [spaceName, setSpaceName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-suggest space name when callsign changes
  useEffect(() => {
    if (callsign && !spaceName) {
      setSpaceName(`${callsign}'s space`)
    }
  }, []) // Only on mount, don't keep updating

  // Update space name suggestion when user types callsign (if they haven't customized it)
  const handleCallsignChange = (value: string) => {
    const newCallsign = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    setCallsign(newCallsign)

    // Auto-update space name if it matches the pattern
    if (spaceName === '' || spaceName === `${callsign}'s space` || spaceName === "'s space") {
      setSpaceName(newCallsign ? `${newCallsign}'s space` : '')
    }
  }

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!callsign.trim() || !spaceName.trim()) return

    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch(`${apiHost}/auth/complete-onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          callsign: callsign.trim(),
          spaceName: spaceName.trim(),
          onboardingToken,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Onboarding failed: ${response.status}`)
      }

      const data = await response.json()
      onComplete(data.userId, data.spaceId)
    } catch (err) {
      console.error('Onboarding failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to complete setup')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Validate callsign format
  const callsignValid = callsign.length >= 2 && callsign.length <= 20 && /^[a-z0-9-]+$/.test(callsign)
  const canSubmit = callsignValid && spaceName.trim().length > 0

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-lg w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-foreground">Welcome to Miriad!</h1>
            <p className="text-muted-foreground">
              Let's set up your account. Choose your callsign—this is how others will mention you.
            </p>
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-base">
            {error}
          </div>
        )}

        {/* Setup form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Callsign input */}
          <div className="space-y-2">
            <label htmlFor="callsign" className="block text-base font-medium text-foreground">
              Your Callsign
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                @
              </span>
              <input
                id="callsign"
                type="text"
                value={callsign}
                onChange={(e) => handleCallsignChange(e.target.value)}
                placeholder="yourname"
                className="w-full pl-8 pr-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                disabled={isSubmitting}
                maxLength={20}
                autoFocus
              />
            </div>
            <p className="text-xs text-muted-foreground">
              2-20 characters, lowercase letters, numbers, and hyphens only
            </p>
            {callsign && !callsignValid && (
              <p className="text-xs text-destructive">
                {callsign.length < 2 ? 'Too short (min 2 characters)' : 'Invalid characters'}
              </p>
            )}
          </div>

          {/* Space name input */}
          <div className="space-y-2">
            <label htmlFor="spaceName" className="block text-base font-medium text-foreground">
              Space Name
            </label>
            <input
              id="spaceName"
              type="text"
              value={spaceName}
              onChange={(e) => setSpaceName(e.target.value)}
              placeholder="My Workspace"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              Your private workspace where you'll manage channels and agents
            </p>
          </div>

          {/* Preview */}
          {callsign && (
            <div className="p-4 bg-card border border-border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground">
                    @{callsign}
                  </div>
                  <div className="text-base text-muted-foreground truncate">
                    {spaceName || 'Your workspace'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={isSubmitting || !canSubmit}
            className="w-full py-3 px-6 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Setting up...
              </>
            ) : (
              'Get Started'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
