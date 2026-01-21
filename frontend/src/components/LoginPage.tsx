/**
 * Login Page (Dev Mode)
 *
 * Shows available spaces to log into, plus a form to create a new space.
 * For development mode only - production uses WorkOS OAuth flow.
 */

import { useState, useEffect } from 'react'
import { User, Plus, Loader2 } from 'lucide-react'
import type { SpaceWithOwner } from '../lib/api'

interface LoginPageProps {
  /** Called after successful login with user and space info */
  onLogin: (userId: string, spaceId: string) => void
  /** API host for backend calls */
  apiHost: string
}

export function LoginPage({ onLogin, apiHost }: LoginPageProps) {
  const [spaces, setSpaces] = useState<SpaceWithOwner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create form state
  const [callsign, setCallsign] = useState('')
  const [spaceName, setSpaceName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Fetch available spaces on mount
  useEffect(() => {
    async function fetchSpaces() {
      try {
        const response = await fetch(`${apiHost}/auth/dev/spaces`, {
          credentials: 'include',
        })
        if (!response.ok) {
          throw new Error(`Failed to fetch spaces: ${response.status}`)
        }
        const data = await response.json()
        setSpaces(data.spaces || [])
      } catch (err) {
        console.error('Failed to fetch spaces:', err)
        setError(err instanceof Error ? err.message : 'Failed to load spaces')
      } finally {
        setLoading(false)
      }
    }
    fetchSpaces()
  }, [apiHost])

  // Handle clicking on a space card to log in
  const handleSpaceLogin = async (spaceId: string) => {
    try {
      const response = await fetch(`${apiHost}/auth/dev/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ spaceId }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Login failed: ${response.status}`)
      }
      const data = await response.json()
      onLogin(data.userId, data.spaceId)
    } catch (err) {
      console.error('Login failed:', err)
      setError(err instanceof Error ? err.message : 'Login failed')
    }
  }

  // Handle creating a new space
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!callsign.trim() || !spaceName.trim()) return

    setIsCreating(true)
    setCreateError(null)

    try {
      const response = await fetch(`${apiHost}/auth/dev/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          callsign: callsign.trim(),
          spaceName: spaceName.trim(),
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Failed to create: ${response.status}`)
      }
      const data = await response.json()
      onLogin(data.userId, data.spaceId)
    } catch (err) {
      console.error('Create failed:', err)
      setCreateError(err instanceof Error ? err.message : 'Failed to create space')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-lg w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Miriad</h1>
          <p className="text-muted-foreground">
            Select a space or create a new one
          </p>
          <div className="inline-block px-2 py-1 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs rounded">
            Development Mode
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-base">
            {error}
          </div>
        )}

        {/* Existing spaces */}
        <div className="space-y-3">
          <h2 className="text-base font-medium text-muted-foreground uppercase tracking-wide">
            Existing Spaces
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : spaces.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-base">
              No spaces yet. Create your first one below.
            </div>
          ) : (
            <div className="space-y-2">
              {spaces.map(({ space, owner }) => (
                <button
                  key={space.id}
                  onClick={() => handleSpaceLogin(space.id)}
                  className="w-full p-4 bg-card border border-border rounded-lg hover:bg-secondary/50 transition-colors text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <User className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {space.name}
                      </div>
                      <div className="text-base text-muted-foreground">
                        @{owner.callsign}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      Click to enter
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">
              Or create new
            </span>
          </div>
        </div>

        {/* Create new space form */}
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="callsign" className="block text-base font-medium text-foreground">
              Your Callsign
            </label>
            <input
              id="callsign"
              type="text"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              placeholder="e.g., simen"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              disabled={isCreating}
            />
            <p className="text-xs text-muted-foreground">
              This is how you'll appear in chat (like @simen)
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="spaceName" className="block text-base font-medium text-foreground">
              Space Name
            </label>
            <input
              id="spaceName"
              type="text"
              value={spaceName}
              onChange={(e) => setSpaceName(e.target.value)}
              placeholder="e.g., My Project"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              disabled={isCreating}
            />
          </div>

          {createError && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-base">
              {createError}
            </div>
          )}

          <button
            type="submit"
            disabled={isCreating || !callsign.trim() || !spaceName.trim()}
            className="w-full py-3 px-6 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Create Space
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
