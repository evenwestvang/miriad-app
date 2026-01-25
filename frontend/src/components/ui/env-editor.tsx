import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Plus, Pencil, Eye, EyeOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'

export interface SecretMetadata {
  setAt: string
  expiresAt?: string
}

export interface EnvEditorProps {
  variables: Record<string, string>
  secrets: Record<string, SecretMetadata>
  artifactSlug: string
  channelId: string
  onVariablesChange: (vars: Record<string, string>) => void
  showExpansionHint?: boolean
  className?: string
}

interface KeyValuePair {
  key: string
  value: string
}

// Check if value contains ${VAR} reference pattern
function hasEnvReference(value: string): boolean {
  return /\$\{[^}]+\}/.test(value)
}

// Format date for display
function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Validate env var key name
function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

export function EnvEditor({
  variables,
  secrets,
  artifactSlug,
  channelId,
  onVariablesChange,
  showExpansionHint = false,
  className,
}: EnvEditorProps) {
  // === Variables Section State ===
  const [localEntries, setLocalEntries] = useState<KeyValuePair[]>(() =>
    Object.entries(variables).map(([key, value]) => ({ key, value }))
  )
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editKey, setEditKey] = useState('')
  const [editValue, setEditValue] = useState('')
  const variablesContainerRef = useRef<HTMLDivElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const valueInputRef = useRef<HTMLInputElement>(null)

  // === Secrets Section State ===
  const [secretsList, setSecretsList] = useState<Array<{ key: string; metadata: SecretMetadata }>>(() =>
    Object.entries(secrets).map(([key, metadata]) => ({ key, metadata }))
  )
  const [secretModalOpen, setSecretModalOpen] = useState(false)
  const [secretModalMode, setSecretModalMode] = useState<'add' | 'edit'>('add')
  const [secretModalKey, setSecretModalKey] = useState('')
  const [secretModalValue, setSecretModalValue] = useState('')
  const [secretModalKeyEditable, setSecretModalKeyEditable] = useState(true)
  const [secretValueVisible, setSecretValueVisible] = useState(false)
  const [secretSaving, setSecretSaving] = useState(false)
  const [secretError, setSecretError] = useState<string | null>(null)

  // Sync local entries when variables prop changes
  useEffect(() => {
    setLocalEntries(Object.entries(variables).map(([key, value]) => ({ key, value })))
  }, [variables])

  // Sync secrets list when secrets prop changes
  useEffect(() => {
    setSecretsList(Object.entries(secrets).map(([key, metadata]) => ({ key, metadata })))
  }, [secrets])

  // Focus key input when starting to edit
  useEffect(() => {
    if (editingIndex !== null && keyInputRef.current) {
      keyInputRef.current.focus()
    }
  }, [editingIndex])

  // === Variables Section Logic ===

  const flushVariablesChanges = useCallback(() => {
    const validEntries = localEntries.filter(e => e.key.trim() !== '' && isValidEnvKey(e.key))
    const newVars = validEntries.reduce((acc, { key, value }) => {
      acc[key] = value
      return acc
    }, {} as Record<string, string>)

    if (JSON.stringify(newVars) !== JSON.stringify(variables)) {
      onVariablesChange(newVars)
    }
  }, [localEntries, variables, onVariablesChange])

  const handleVariablesContainerBlur = (e: React.FocusEvent) => {
    if (!variablesContainerRef.current?.contains(e.relatedTarget as Node)) {
      if (editingIndex !== null) {
        commitCurrentEdit()
      }
      setTimeout(() => flushVariablesChanges(), 0)
    }
  }

  const commitCurrentEdit = () => {
    if (editingIndex === null) return

    const newEntries = [...localEntries]
    newEntries[editingIndex] = { key: editKey, value: editValue }
    setLocalEntries(newEntries)
    setEditingIndex(null)
    setEditKey('')
    setEditValue('')

    // Flush immediately after committing
    const validEntries = newEntries.filter(e => e.key.trim() !== '' && isValidEnvKey(e.key))
    const newVars = validEntries.reduce((acc, { key, value }) => {
      acc[key] = value
      return acc
    }, {} as Record<string, string>)
    onVariablesChange(newVars)
  }

  const handleStartEdit = (index: number) => {
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    setEditingIndex(index)
    setEditKey(localEntries[index].key)
    setEditValue(localEntries[index].value)
  }

  const handleSaveEdit = () => {
    commitCurrentEdit()
  }

  const handleCancelEdit = () => {
    if (editingIndex !== null && localEntries[editingIndex].key === '' && editKey === '') {
      setLocalEntries(localEntries.filter((_, i) => i !== editingIndex))
    }
    setEditingIndex(null)
    setEditKey('')
    setEditValue('')
  }

  const handleDeleteVariable = (index: number) => {
    const newEntries = localEntries.filter((_, i) => i !== index)
    setLocalEntries(newEntries)
    const validEntries = newEntries.filter(e => e.key.trim() !== '' && isValidEnvKey(e.key))
    const newVars = validEntries.reduce((acc, { key, value }) => {
      acc[key] = value
      return acc
    }, {} as Record<string, string>)
    onVariablesChange(newVars)
  }

  const handleAddVariable = () => {
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    const newEntries = [...localEntries, { key: '', value: '' }]
    setLocalEntries(newEntries)
    setEditingIndex(newEntries.length - 1)
    setEditKey('')
    setEditValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent, field: 'key' | 'value') => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
    if (e.key === 'Tab' && !e.shiftKey && field === 'key') {
      e.preventDefault()
      valueInputRef.current?.focus()
    }
  }

  // === Secrets Section Logic ===

  const handleAddSecret = () => {
    setSecretModalMode('add')
    setSecretModalKey('')
    setSecretModalValue('')
    setSecretModalKeyEditable(true)
    setSecretValueVisible(false)
    setSecretError(null)
    setSecretModalOpen(true)
  }

  const handleEditSecret = (key: string) => {
    setSecretModalMode('edit')
    setSecretModalKey(key)
    setSecretModalValue('')
    setSecretModalKeyEditable(false)
    setSecretValueVisible(false)
    setSecretError(null)
    setSecretModalOpen(true)
  }

  const handleDeleteSecret = async (key: string) => {
    try {
      const response = await apiFetch(`/channels/${channelId}/artifacts/${artifactSlug}/secrets/${key}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete secret')
      }
      setSecretsList(secretsList.filter(s => s.key !== key))
    } catch (err) {
      console.error('Failed to delete secret:', err)
    }
  }

  const handleSaveSecret = async () => {
    if (!secretModalKey.trim()) {
      setSecretError('Key is required')
      return
    }
    if (!isValidEnvKey(secretModalKey)) {
      setSecretError('Invalid key name. Use letters, numbers, and underscores. Must start with a letter or underscore.')
      return
    }
    if (!secretModalValue) {
      setSecretError('Value is required')
      return
    }

    setSecretSaving(true)
    setSecretError(null)

    try {
      const response = await apiFetch(`/channels/${channelId}/artifacts/${artifactSlug}/secrets/${secretModalKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: secretModalValue }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save secret')
      }

      const result = await response.json()

      // Update local state
      const existingIndex = secretsList.findIndex(s => s.key === secretModalKey)
      if (existingIndex >= 0) {
        const updated = [...secretsList]
        updated[existingIndex] = { key: secretModalKey, metadata: { setAt: result.setAt } }
        setSecretsList(updated)
      } else {
        setSecretsList([...secretsList, { key: secretModalKey, metadata: { setAt: result.setAt } }])
      }

      setSecretModalOpen(false)
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Failed to save secret')
    } finally {
      setSecretSaving(false)
    }
  }

  const inputClasses = 'flex-1 h-8 px-2 text-base font-mono bg-secondary border border-border focus:outline-none focus:ring-0 focus:border-foreground'

  return (
    <div className={cn('space-y-6', className)}>
      {/* Variables Section */}
      <div
        ref={variablesContainerRef}
        className="space-y-2"
        onBlur={handleVariablesContainerBlur}
      >
        <div className="flex items-center justify-between">
          <label className="block text-xs font-medium text-muted-foreground uppercase">
            Variables
          </label>
          {showExpansionHint && (
            <span className="text-xs text-muted-foreground">
              Use <code className="bg-secondary px-1 rounded">{'${VAR}'}</code> to reference shared environment
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Plaintext values, visible to all users
        </p>

        <div className="rounded-md border bg-secondary/30">
          {localEntries.length === 0 ? (
            <div className="px-3 py-2 text-base text-muted-foreground italic">
              No variables configured
            </div>
          ) : (
            <div className="divide-y divide-border">
              {localEntries.map((entry, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 px-2 py-1.5 group"
                >
                  {editingIndex === index ? (
                    <>
                      <input
                        ref={keyInputRef}
                        type="text"
                        value={editKey}
                        onChange={(e) => setEditKey(e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, 'key')}
                        placeholder="VARIABLE_NAME"
                        className={cn(inputClasses, !isValidEnvKey(editKey) && editKey && 'border-red-500')}
                      />
                      <input
                        ref={valueInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, 'value')}
                        placeholder="value"
                        className={inputClasses}
                      />
                      <button
                        className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleDeleteVariable(index)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <div
                        className="flex-1 px-2 py-1 text-base font-mono cursor-pointer hover:bg-secondary/50 rounded truncate"
                        onClick={() => handleStartEdit(index)}
                      >
                        {entry.key || <span className="text-muted-foreground italic">VARIABLE_NAME</span>}
                      </div>
                      <div
                        className={cn(
                          'flex-1 px-2 py-1 text-base font-mono cursor-pointer hover:bg-secondary/50 rounded truncate',
                          hasEnvReference(entry.value) && 'bg-blue-500/10 text-blue-300'
                        )}
                        onClick={() => handleStartEdit(index)}
                        title={hasEnvReference(entry.value) ? 'References environment variable' : undefined}
                      >
                        {entry.value || <span className="text-muted-foreground italic">value</span>}
                      </div>
                      <button
                        className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleDeleteVariable(index)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border">
            <button
              onClick={handleAddVariable}
              className="flex items-center gap-1.5 px-3 py-2 text-base text-muted-foreground hover:text-foreground hover:bg-secondary/50 w-full transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add variable
            </button>
          </div>
        </div>
      </div>

      {/* Secrets Section */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          Secrets
        </label>
        <p className="text-xs text-muted-foreground">
          Write-only. Values cannot be read after saving.
        </p>

        <div className="rounded-md border bg-secondary/30">
          {secretsList.length === 0 ? (
            <div className="px-3 py-2 text-base text-muted-foreground italic">
              No secrets configured
            </div>
          ) : (
            <div className="divide-y divide-border">
              {secretsList.map(({ key, metadata }) => (
                <div
                  key={key}
                  className="flex items-center gap-2 px-2 py-1.5 group"
                >
                  <div className="flex-1 px-2 py-1 text-base font-mono truncate">
                    {key}
                  </div>
                  <div className="flex-1 px-2 py-1 text-xs text-muted-foreground truncate">
                    {formatDate(metadata.setAt)}
                  </div>
                  <button
                    className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleEditSecret(key)}
                    title="Update secret"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleDeleteSecret(key)}
                    title="Delete secret"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-border">
            <button
              onClick={handleAddSecret}
              className="flex items-center gap-1.5 px-3 py-2 text-base text-muted-foreground hover:text-foreground hover:bg-secondary/50 w-full transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add secret
            </button>
          </div>
        </div>
      </div>

      {/* Secret Modal */}
      {secretModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="px-4 py-3 border-b">
              <h3 className="text-base font-medium">
                {secretModalMode === 'add' ? 'Add Secret' : `Update Secret: ${secretModalKey}`}
              </h3>
            </div>

            <div className="p-4 space-y-4">
              {secretModalKeyEditable && (
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-muted-foreground">
                    Key
                  </label>
                  <input
                    type="text"
                    value={secretModalKey}
                    onChange={(e) => setSecretModalKey(e.target.value)}
                    placeholder="SECRET_NAME"
                    className={cn(
                      'w-full h-9 px-3 text-base font-mono bg-secondary border border-border focus:outline-none focus:ring-0 focus:border-foreground',
                      !isValidEnvKey(secretModalKey) && secretModalKey && 'border-red-500'
                    )}
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-medium text-muted-foreground">
                  {secretModalMode === 'add' ? 'Value' : 'New Value'}
                </label>
                <div className="relative">
                  <input
                    type={secretValueVisible ? 'text' : 'password'}
                    value={secretModalValue}
                    onChange={(e) => setSecretModalValue(e.target.value)}
                    placeholder="Enter secret value"
                    className="w-full h-9 px-3 pr-10 text-base font-mono bg-secondary border border-border focus:outline-none focus:ring-0 focus:border-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => setSecretValueVisible(!secretValueVisible)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {secretValueVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {secretModalMode === 'edit' && (
                <p className="text-xs text-amber-500">
                  This will overwrite the current value.
                </p>
              )}

              {secretError && (
                <p className="text-xs text-red-500">{secretError}</p>
              )}
            </div>

            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <button
                onClick={() => setSecretModalOpen(false)}
                className="px-3 py-1.5 text-base rounded border border-border hover:bg-secondary transition-colors"
                disabled={secretSaving}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSecret}
                disabled={secretSaving}
                className="px-3 py-1.5 text-base rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {secretSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
