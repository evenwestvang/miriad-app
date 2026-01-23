/**
 * Disclaimer Page
 *
 * Displays the legal disclaimer and requires users to type
 * "I accept the responsibility" to continue.
 */

import { useState, useEffect } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchDisclaimer, acceptDisclaimer, type DisclaimerResponse } from '../lib/api'

interface DisclaimerPageProps {
  /** Called after successful acceptance */
  onAccept: () => void
}

export function DisclaimerPage({ onAccept }: DisclaimerPageProps) {
  const [disclaimer, setDisclaimer] = useState<DisclaimerResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [confirmation, setConfirmation] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Fetch disclaimer on mount
  useEffect(() => {
    async function loadDisclaimer() {
      try {
        const data = await fetchDisclaimer()
        setDisclaimer(data)
      } catch (err) {
        console.error('Failed to fetch disclaimer:', err)
        setError(err instanceof Error ? err.message : 'Failed to load disclaimer')
      } finally {
        setLoading(false)
      }
    }
    loadDisclaimer()
  }, [])

  const isConfirmationValid =
    confirmation.toLowerCase().trim() === 'i accept the responsibility'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isConfirmationValid || !disclaimer) return

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      await acceptDisclaimer({
        confirmation: confirmation.trim(),
        version: disclaimer.version,
      })
      onAccept()
    } catch (err) {
      console.error('Failed to accept disclaimer:', err)
      setSubmitError(
        err instanceof Error ? err.message : 'Failed to accept disclaimer'
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !disclaimer) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <h1 className="text-xl font-bold text-foreground">
            Unable to Load Disclaimer
          </h1>
          <p className="text-muted-foreground">
            {error || 'No disclaimer found'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-foreground">
            {disclaimer.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            Version {disclaimer.version}
          </p>
        </div>

        {/* Disclaimer content */}
        <div className="bg-card border border-border rounded-lg p-6 max-h-[50vh] overflow-y-auto">
          <Markdown
            className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            remarkPlugins={[remarkGfm]}
          >
            {disclaimer.content}
          </Markdown>
        </div>

        {/* Acceptance form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="confirmation"
              className="block text-sm font-medium text-foreground"
            >
              To continue, please type:{' '}
              <span className="font-mono bg-muted px-2 py-0.5 rounded">
                I accept the responsibility
              </span>
            </label>
            <input
              id="confirmation"
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="Type here..."
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              disabled={isSubmitting}
              autoComplete="off"
              autoFocus
            />
          </div>

          {submitError && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={!isConfirmationValid || isSubmitting}
            className="w-full py-3 px-6 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing...
              </>
            ) : (
              'Accept'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
