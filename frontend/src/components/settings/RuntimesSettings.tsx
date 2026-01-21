import { useState } from 'react'
import { Copy, Check, Plus, RefreshCw } from 'lucide-react'
import { apiPost } from '../../lib/api'

interface BootstrapTokenResponse {
  bootstrapToken: string
  expiresAt: string
  connectionString: string
  command: string
}

interface RuntimesSettingsProps {
  apiHost: string
  spaceId: string
}

export function RuntimesSettings({ apiHost, spaceId: _spaceId }: RuntimesSettingsProps) {
  const [generatingToken, setGeneratingToken] = useState(false)
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generateBootstrapToken() {
    setGeneratingToken(true)
    setError(null)
    setGeneratedCommand(null)
    try {
      const data = await apiPost<BootstrapTokenResponse>(
        `${apiHost}/api/runtimes/auth/bootstrap-token`,
        {}
      )
      setGeneratedCommand(data.command)
      setExpiresAt(data.expiresAt)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token')
    } finally {
      setGeneratingToken(false)
    }
  }

  function copyCommand() {
    if (generatedCommand) {
      navigator.clipboard.writeText(generatedCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  function formatExpiryTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = date.getTime() - now.getTime()
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins <= 0) return 'expired'
    if (diffMins < 60) return `${diffMins} minutes`
    return `${Math.floor(diffMins / 60)} hours`
  }

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-base text-destructive">
          {error}
        </div>
      )}

      {/* Header */}
      <div>
        <h3 className="text-lg font-medium text-foreground">Connect Local Runtime</h3>
        <p className="text-base text-muted-foreground mt-1">
          Run agents on your own hardware by connecting a local runtime.
        </p>
      </div>

      {/* Generate connection command section */}
      <div className="space-y-3">
        <button
          onClick={generateBootstrapToken}
          disabled={generatingToken}
          className="flex items-center gap-2 px-3 py-1.5 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {generatingToken ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Generate Connection Command
            </>
          )}
        </button>

        {/* Generated command display */}
        {generatedCommand && (
          <div className="space-y-2">
            <p className="text-base text-muted-foreground">
              Run this command on your machine:
            </p>
            <div className="relative">
              <div className="p-3 pr-12 bg-secondary/50 border border-border rounded-md font-mono text-base break-all">
                {generatedCommand}
              </div>
              <button
                onClick={copyCommand}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-secondary rounded-md transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </div>
            {expiresAt && (
              <p className="text-xs text-muted-foreground">
                This command expires in {formatExpiryTime(expiresAt)}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
