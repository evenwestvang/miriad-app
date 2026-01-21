/**
 * Initialize Root Channel Page
 *
 * A simple page with a confirm button that resets the root channel
 * by deleting all existing artifacts and re-seeding from Sanity.
 * Used for debugging onboarding/curation flows.
 */

import { useState } from 'react'
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { API_HOST } from '../lib/api'

interface InitializeRootChannelPageProps {
  onComplete: () => void
}

export function InitializeRootChannelPage({ onComplete }: InitializeRootChannelPageProps) {
  const [isResetting, setIsResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ deletedCount: number; createdCount: number } | null>(null)

  const handleReset = async () => {
    setIsResetting(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch(`${API_HOST}/initialize-root-channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.message || data.error || `Reset failed: ${response.status}`)
      }

      const data = await response.json()
      setResult({ deletedCount: data.deletedCount, createdCount: data.createdCount })

      // Redirect after a brief delay to show the result
      setTimeout(() => {
        onComplete()
      }, 2000)
    } catch (err) {
      console.error('Reset failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to reset root channel')
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-yellow-500/10 mb-4">
            <AlertTriangle className="w-8 h-8 text-yellow-500" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Reset Root Channel</h1>
          <p className="text-muted-foreground">
            This will delete all existing artifacts in the root channel and re-seed from Sanity.
          </p>
        </div>

        {/* Warning */}
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <p className="text-base text-yellow-600 dark:text-yellow-400">
            <strong>Warning:</strong> This action will permanently delete all system artifacts (agents, MCP servers, playbooks)
            and create new ones from the current Sanity content. Use this for testing onboarding flows.
          </p>
        </div>

        {/* Error display */}
        {error && (
          <div className="p-4 bg-destructive/10 text-destructive rounded-lg text-base">
            {error}
          </div>
        )}

        {/* Success display */}
        {result && (
          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
            <p className="text-base text-green-600 dark:text-green-400">
              <strong>Success!</strong> Deleted {result.deletedCount} artifacts,
              created {result.createdCount} new artifacts. Redirecting...
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={() => onComplete()}
            disabled={isResetting}
            className="flex-1 py-3 px-6 bg-secondary text-secondary-foreground rounded-lg font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleReset}
            disabled={isResetting || result !== null}
            className="flex-1 py-3 px-6 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isResetting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Resetting...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Reset Root Channel
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
