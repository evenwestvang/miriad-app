import { useState, useEffect } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import { fetchAvailableApps, type AppDefinition } from '../../lib/apps'

export interface AppProps {
  provider: string
  settings?: Record<string, unknown>
}

interface AppPropsEditorProps {
  props: AppProps
  onChange: (updates: Partial<AppProps>) => void
}

/**
 * AppPropsEditor
 *
 * Editor for system.app artifact props.
 * Fetches available providers from registry and lets user select one.
 */
export function AppPropsEditor({ props, onChange }: AppPropsEditorProps) {
  const [apps, setApps] = useState<AppDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch available apps on mount
  useEffect(() => {
    setLoading(true)
    setError(null)

    fetchAvailableApps()
      .then((apps) => {
        setApps(apps)
        // If no provider selected yet and we have apps, select the first one
        if (!props.provider && apps.length > 0) {
          onChange({ provider: apps[0].id })
        }
      })
      .catch((err) => {
        setError(err.message || 'Failed to load apps')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  const selectedApp = apps.find((app) => app.id === props.provider)

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-base">Loading available apps...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded text-base text-destructive">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Failed to load apps</p>
          <p className="text-base mt-0.5">{error}</p>
        </div>
      </div>
    )
  }

  if (apps.length === 0) {
    return (
      <div className="py-4 text-base text-muted-foreground text-center">
        No apps available in the registry yet.
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Provider select */}
      <div>
        <label className="block text-base text-muted-foreground mb-1">
          Provider <span className="text-red-500">*</span>
        </label>
        <select
          className="w-full px-2 py-1.5 text-base bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
          value={props.provider}
          onChange={(e) => onChange({ provider: e.target.value })}
        >
          <option value="">Select a provider...</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </div>

      {/* Selected app info */}
      {selectedApp && (
        <div className="p-3 bg-secondary/30 rounded-md">
          <p className="text-base font-medium text-foreground">{selectedApp.name}</p>
          <p className="text-base text-muted-foreground mt-1">{selectedApp.description}</p>
          {selectedApp.scopes.length > 0 && (
            <p className="text-base text-muted-foreground/60 mt-2">
              <span className="font-medium">Scopes:</span> {selectedApp.scopes.join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Note about OAuth */}
      <p className="text-base text-muted-foreground">
        After creating this artifact, you'll need to connect your account via OAuth to enable the integration.
      </p>
    </div>
  )
}
