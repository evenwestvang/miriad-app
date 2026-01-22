import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, RefreshCw, Trash2, Github, Copy, Check, Brain } from 'lucide-react'
import { apiJson, apiPut, apiDelete } from '../../lib/api'

const GITHUB_TOKEN_KEY = 'github_token'
const LETTA_API_KEY = 'letta_api_key'

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
  // GitHub state
  const [githubToken, setGithubToken] = useState('')
  const [showGithubToken, setShowGithubToken] = useState(false)
  const [savingGithub, setSavingGithub] = useState(false)
  const [deletingGithub, setDeletingGithub] = useState(false)
  const [githubSetAt, setGithubSetAt] = useState<string | null>(null)
  const [copiedGithub, setCopiedGithub] = useState(false)

  // Letta state
  const [lettaApiKey, setLettaApiKey] = useState('')
  const [showLettaKey, setShowLettaKey] = useState(false)
  const [savingLetta, setSavingLetta] = useState(false)
  const [deletingLetta, setDeletingLetta] = useState(false)
  const [lettaSetAt, setLettaSetAt] = useState<string | null>(null)

  // Shared state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleCopyGithubCommand() {
    await navigator.clipboard.writeText('gh auth token')
    setCopiedGithub(true)
    setTimeout(() => setCopiedGithub(false), 2000)
  }

  useEffect(() => {
    async function loadSecrets() {
      try {
        const data = await apiJson<SecretsListResponse>(
          `${apiHost}/api/spaces/${spaceId}/secrets`
        )
        if (data.secrets[GITHUB_TOKEN_KEY]) {
          setGithubSetAt(data.secrets[GITHUB_TOKEN_KEY].setAt)
        }
        if (data.secrets[LETTA_API_KEY]) {
          setLettaSetAt(data.secrets[LETTA_API_KEY].setAt)
        }
      } catch (err) {
        console.error('Failed to load secrets:', err)
      } finally {
        setLoading(false)
      }
    }
    loadSecrets()
  }, [apiHost, spaceId])

  async function handleSaveGithub() {
    if (!githubToken.trim()) {
      setError('Token is required')
      return
    }

    setSavingGithub(true)
    setError(null)
    setSaved(false)

    try {
      const result = await apiPut<{ key: string; setAt: string }>(
        `${apiHost}/api/spaces/${spaceId}/secrets/${GITHUB_TOKEN_KEY}`,
        { value: githubToken }
      )
      setGithubSetAt(result.setAt)
      setGithubToken('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token')
    } finally {
      setSavingGithub(false)
    }
  }

  async function handleDeleteGithub() {
    setDeletingGithub(true)
    setError(null)

    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/secrets/${GITHUB_TOKEN_KEY}`)
      setGithubSetAt(null)
      setGithubToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token')
    } finally {
      setDeletingGithub(false)
    }
  }

  async function handleSaveLetta() {
    if (!lettaApiKey.trim()) {
      setError('API key is required')
      return
    }

    setSavingLetta(true)
    setError(null)
    setSaved(false)

    try {
      const result = await apiPut<{ key: string; setAt: string }>(
        `${apiHost}/api/spaces/${spaceId}/secrets/${LETTA_API_KEY}`,
        { value: lettaApiKey }
      )
      setLettaSetAt(result.setAt)
      setLettaApiKey('')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key')
    } finally {
      setSavingLetta(false)
    }
  }

  async function handleDeleteLetta() {
    setDeletingLetta(true)
    setError(null)

    try {
      await apiDelete(`${apiHost}/api/spaces/${spaceId}/secrets/${LETTA_API_KEY}`)
      setLettaSetAt(null)
      setLettaApiKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete API key')
    } finally {
      setDeletingLetta(false)
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

          {githubSetAt ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-secondary/30 border border-border rounded-md">
                <div className="flex-1">
                  <div className="font-mono text-base">ghp_••••••••••••••••</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Set on {formatDate(githubSetAt)}
                  </div>
                </div>
                <button
                  onClick={handleDeleteGithub}
                  disabled={deletingGithub}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-base text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                  title="Remove token"
                >
                  {deletingGithub ? (
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
                  type={showGithubToken ? 'text' : 'password'}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_... or paste from 'gh auth token'"
                  className="w-full px-3 py-2 pr-10 bg-secondary/30 border border-border rounded-md text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="button"
                  onClick={() => setShowGithubToken(!showGithubToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-secondary rounded transition-colors"
                  title={showGithubToken ? 'Hide token' : 'Show token'}
                >
                  {showGithubToken ? (
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
                  onClick={handleCopyGithubCommand}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-secondary/50 hover:bg-secondary rounded transition-colors font-mono"
                  title="Copy command"
                >
                  gh auth token
                  {copiedGithub ? (
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
                onClick={handleSaveGithub}
                disabled={savingGithub || !githubToken.trim()}
                className="flex items-center gap-2 px-4 py-2 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingGithub ? (
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

      {/* Letta Integration */}
      <div className="space-y-4 pt-4 border-t border-border">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-secondary/50 rounded-md">
            <Brain className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">Letta</h3>
            <p className="text-sm text-muted-foreground">
              Enable agents with persistent long-term memory
            </p>
          </div>
        </div>

        <div className="space-y-2 pl-12">
          <label htmlFor="letta-api-key" className="block text-base font-medium text-foreground">
            API Key
          </label>

          {lettaSetAt ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-secondary/30 border border-border rounded-md">
                <div className="flex-1">
                  <div className="font-mono text-base">sk-••••••••••••••••</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Set on {formatDate(lettaSetAt)}
                  </div>
                </div>
                <button
                  onClick={handleDeleteLetta}
                  disabled={deletingLetta}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-base text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                  title="Remove API key"
                >
                  {deletingLetta ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Remove
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                To update your API key, remove the existing one and add a new one.
              </p>
            </div>
          ) : (
            <>
              <div className="relative">
                <input
                  id="letta-api-key"
                  type={showLettaKey ? 'text' : 'password'}
                  value={lettaApiKey}
                  onChange={(e) => setLettaApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 pr-10 bg-secondary/30 border border-border rounded-md text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  type="button"
                  onClick={() => setShowLettaKey(!showLettaKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-secondary rounded transition-colors"
                  title={showLettaKey ? 'Hide key' : 'Show key'}
                >
                  {showLettaKey ? (
                    <EyeOff className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Get your API key from{' '}
                <a
                  href="https://app.letta.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  app.letta.com
                </a>
                . Agents with <code className="px-1 py-0.5 bg-secondary/50 rounded">engine: "letta"</code> will use persistent memory.
              </p>

              {/* Save button */}
              <button
                onClick={handleSaveLetta}
                disabled={savingLetta || !lettaApiKey.trim()}
                className="flex items-center gap-2 px-4 py-2 text-base bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingLetta ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save API Key
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
