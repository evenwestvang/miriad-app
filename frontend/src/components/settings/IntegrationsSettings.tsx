import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, RefreshCw, Trash2, Github, Copy, Check } from 'lucide-react'
import { apiJson, apiPut, apiDelete } from '../../lib/api'

const GITHUB_TOKEN_KEY = 'github_token'

interface SecretMetadata {
  setAt: string
  expiresAt?: string
}

interface SecretsListResponse {
  secrets: Record<string, SecretMetadata>
}

interface IntegrationsSettingsProps {
  apiHost: string
  spaceId: string
}

export function IntegrationsSettings({ apiHost, spaceId }: IntegrationsSettingsProps) {
  const [githubToken, setGithubToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [existingTokenSetAt, setExistingTokenSetAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleCopyCommand() {
    await navigator.clipboard.writeText('gh auth token')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    async function loadSecrets() {
      try {
        const data = await apiJson<SecretsListResponse>(
          `${apiHost}/api/spaces/${spaceId}/secrets`
        )
        const meta = data.secrets[GITHUB_TOKEN_KEY]
        if (meta) {
          setExistingTokenSetAt(meta.setAt)
        }
      } catch (err) {
        console.error('Failed to load secrets:', err)
      } finally {
        setLoading(false)
      }
    }
    loadSecrets()
  }, [apiHost, spaceId])

  async function handleSave() {
    if (!githubToken.trim()) {
      setError('Token is required')
      return
    }

    setSaving(true)
    setError(null)
    setSaved(false)

    try {
      const result = await apiPut<{ key: string; setAt: string }>(
        `${apiHost}/api/spaces/${spaceId}/secrets/${GITHUB_TOKEN_KEY}`,
        { value: githubToken }
      )
      setExistingTokenSetAt(result.setAt)
      setGithubToken('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)

    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/secrets/${GITHUB_TOKEN_KEY}`)
      setExistingTokenSetAt(null)
      setGithubToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token')
    } finally {
      setDeleting(false)
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading...
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-base text-destructive">
          {error}
        </div>
      )}

      {/* Success display */}
      {saved && (
        <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-md text-base text-green-600">
          Token saved successfully
        </div>
      )}

      {/* GitHub Integration */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-secondary/50 rounded-md">
            <Github className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">GitHub</h3>
            <p className="text-sm text-muted-foreground">
              Authenticate git operations in agent containers
            </p>
          </div>
        </div>

        <div className="space-y-2 pl-12">
          <label htmlFor="github-token" className="block text-base font-medium text-foreground">
            Personal Access Token
          </label>

          {existingTokenSetAt ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-secondary/30 border border-border rounded-md">
                <div className="flex-1">
                  <div className="font-mono text-base">ghp_••••••••••••••••</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Set on {formatDate(existingTokenSetAt)}
                  </div>
                </div>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-base text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                  title="Remove token"
                >
                  {deleting ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Remove
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                To update your token, remove the existing one and add a new one.
              </p>
            </div>
          ) : (
            <>
              <div className="relative">
                <input
                  id="github-token"
                  type={showToken ? 'text' : 'password'}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_... or paste from 'gh auth token'"
                  className="w-full px-3 py-2 pr-10 bg-secondary/30 border border-border rounded-md text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-secondary rounded transition-colors"
                  title={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Quick: run{' '}
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-secondary/50 hover:bg-secondary rounded transition-colors font-mono"
                  title="Copy command"
                >
                  gh auth token
                  {copied ? (
                    <Check className="w-3 h-3 text-green-500" />
                  ) : (
                    <Copy className="w-3 h-3 text-muted-foreground" />
                  )}
                </button>{' '}
                if using GitHub CLI. Or{' '}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  create a token
                </a>{' '}
                with <code className="px-1 py-0.5 bg-secondary/50 rounded">repo</code> scope.
              </p>

              {/* Save button */}
              <button
                onClick={handleSave}
                disabled={saving || !githubToken.trim()}
                className="flex items-center gap-2 px-4 py-2 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Token
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Future integrations placeholder */}
      <div className="pt-4 border-t border-border">
        <p className="text-sm text-muted-foreground">
          More integrations coming soon.
        </p>
      </div>
    </div>
  )
}
