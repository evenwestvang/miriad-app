import { useState, useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import type { Artifact, ArtifactType, ArtifactStatus, ArtifactTreeNode } from '../../types/artifact'

interface ArtifactEditProps {
  artifact: Artifact
  channelId: string
  apiHost: string
  tree: ArtifactTreeNode[]
  onSuccess: (artifact: Artifact) => void
  onCancel: () => void
}

// Available types for editing
const ARTIFACT_TYPES: ArtifactType[] = ['doc', 'task', 'decision', 'code']

// Status options based on type
const DOC_STATUSES: ArtifactStatus[] = ['draft', 'active', 'archived']
const TASK_STATUSES: ArtifactStatus[] = ['pending', 'in_progress', 'done', 'blocked', 'archived']

interface ConflictInfo {
  field: string
  expected: unknown
  actual: unknown
}

export function ArtifactEdit({
  artifact,
  channelId,
  apiHost,
  tree,
  onSuccess,
  onCancel,
}: ArtifactEditProps) {
  // Form state - track original values for CAS
  const [title, setTitle] = useState(artifact.title || '')
  const [type, setType] = useState<ArtifactType>(artifact.type as ArtifactType)
  const [status, setStatus] = useState<ArtifactStatus>(artifact.status)
  const [tldr, setTldr] = useState(artifact.tldr)
  const [content, setContent] = useState(artifact.content)
  const [parentSlug, setParentSlug] = useState(artifact.parentSlug || '')

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)

  // Get available parent options (flatten tree, exclude self and children)
  const parentOptions = getParentOptions(tree, artifact.slug)

  // Get status options based on type
  const statusOptions = type === 'task' ? TASK_STATUSES : DOC_STATUSES

  // Build CAS changes array (metadata only, not content)
  const buildChanges = useCallback(() => {
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []

    if (title !== (artifact.title || '')) {
      changes.push({ field: 'title', oldValue: artifact.title, newValue: title || undefined })
    }
    if (type !== artifact.type) {
      changes.push({ field: 'type', oldValue: artifact.type, newValue: type })
    }
    if (status !== artifact.status) {
      changes.push({ field: 'status', oldValue: artifact.status, newValue: status })
    }
    if (tldr !== artifact.tldr) {
      changes.push({ field: 'tldr', oldValue: artifact.tldr, newValue: tldr })
    }
    // Note: content is handled separately via the edit endpoint
    if (parentSlug !== (artifact.parentSlug || '')) {
      changes.push({ field: 'parentSlug', oldValue: artifact.parentSlug, newValue: parentSlug || null })
    }

    return changes
  }, [artifact, title, type, status, tldr, parentSlug])

  // Check if content has changed
  const hasContentChanged = useCallback(() => {
    return content !== artifact.content
  }, [artifact.content, content])

  const handleSave = async () => {
    const changes = buildChanges()
    const contentChanged = hasContentChanged()

    if (changes.length === 0 && !contentChanged) {
      onCancel() // No changes
      return
    }

    setSaving(true)
    setError(null)
    setConflict(null)

    try {
      let updatedArtifact = artifact

      // First, handle content changes via the edit endpoint
      if (contentChanged) {
        const editResponse = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            old_string: artifact.content,
            new_string: content,
            sender: 'user', // TODO: Get from auth context
          }),
        })

        if (editResponse.status === 409) {
          setConflict({ field: 'content', expected: artifact.content, actual: 'modified by another user' })
          return
        }

        if (!editResponse.ok) {
          const data = await editResponse.json()
          throw new Error(data.error || 'Failed to save content')
        }

        const editData = await editResponse.json()
        updatedArtifact = editData.artifact || updatedArtifact
      }

      // Then, handle metadata changes via PATCH
      if (changes.length > 0) {
        const patchResponse = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes,
            sender: 'user', // TODO: Get from auth context
          }),
        })

        if (patchResponse.status === 409) {
          const data = await patchResponse.json()
          setConflict(data.conflict)
          return
        }

        if (!patchResponse.ok) {
          const data = await patchResponse.json()
          throw new Error(data.error || 'Failed to save')
        }

        const patchData = await patchResponse.json()
        updatedArtifact = patchData.artifact || updatedArtifact
      }

      onSuccess(updatedArtifact)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleOverwrite = async () => {
    // Force save without CAS - use simple update mode
    setSaving(true)
    setError(null)
    setConflict(null)

    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'simple',
          updates: {
            title: title || undefined,
            type,
            status,
            tldr,
            content,
            parentSlug: parentSlug || null,
          },
          sender: 'user',
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to save')
      }

      const data = await response.json()
      onSuccess(data.artifact)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = buildChanges().length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium text-base text-foreground">Edit: {artifact.slug}</span>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 text-base text-muted-foreground hover:text-foreground transition-colors"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className={cn(
              "px-2 py-1 text-base rounded transition-colors",
              hasChanges && !saving
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-secondary text-muted-foreground cursor-not-allowed"
            )}
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="px-3 py-2 bg-red-100 text-red-700 text-base">
          {error}
        </div>
      )}

      {/* Conflict dialog */}
      {conflict && (
        <div className="px-3 py-3 bg-yellow-50 border-b border-yellow-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-base text-yellow-800">Edit Conflict</div>
              <div className="text-base text-yellow-700 mt-1">
                The field "{conflict.field}" was modified by someone else while you were editing.
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  className="px-2 py-1 text-base bg-yellow-200 text-yellow-800 rounded hover:bg-yellow-300"
                  onClick={handleOverwrite}
                >
                  Overwrite
                </button>
                <button
                  className="px-2 py-1 text-base text-yellow-700 hover:text-yellow-900"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
                <button
                  className="px-2 py-1 text-base text-yellow-700 hover:text-yellow-900"
                  onClick={() => setConflict(null)}
                >
                  Continue Editing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Title */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">Title</label>
          <input
            type="text"
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Optional display name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">Type</label>
          <select
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            value={type}
            onChange={(e) => {
              const newType = e.target.value as ArtifactType
              setType(newType)
              // Reset status if type changed
              if (newType === 'task' && !TASK_STATUSES.includes(status)) {
                setStatus('pending')
              } else if (newType !== 'task' && !DOC_STATUSES.includes(status)) {
                setStatus('draft')
              }
            }}
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">Status</label>
          <select
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            value={status}
            onChange={(e) => setStatus(e.target.value as ArtifactStatus)}
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* TLDR */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">TLDR (required)</label>
          <textarea
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            rows={2}
            placeholder="Brief summary (1-3 sentences)"
            value={tldr}
            onChange={(e) => setTldr(e.target.value)}
          />
        </div>

        {/* Content */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">Content</label>
          <textarea
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-none"
            rows={10}
            placeholder="Markdown content..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>

        {/* Parent */}
        <div>
          <label className="block text-base text-muted-foreground mb-1">Parent</label>
          <select
            className="w-full px-2 py-1.5 text-base bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            value={parentSlug}
            onChange={(e) => setParentSlug(e.target.value)}
          >
            <option value="">(root level)</option>
            {parentOptions.map((opt) => (
              <option key={opt.slug} value={opt.slug}>
                {opt.path}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

interface ParentOption {
  slug: string
  path: string
}

/**
 * Flatten tree to get list of possible parent options.
 * Excludes the artifact itself and its children.
 */
function getParentOptions(
  nodes: ArtifactTreeNode[],
  excludeSlug: string,
  prefix = ''
): ParentOption[] {
  const options: ParentOption[] = []

  for (const node of nodes) {
    if (node.slug === excludeSlug) continue

    const path = prefix ? `${prefix}/${node.slug}` : node.slug
    options.push({ slug: node.slug, path })

    if (node.children) {
      // Don't include children of excluded node
      const isExcludedChild = isDescendant(node.children, excludeSlug)
      if (!isExcludedChild) {
        options.push(...getParentOptions(node.children, excludeSlug, path))
      }
    }
  }

  return options
}

function isDescendant(nodes: ArtifactTreeNode[], slug: string): boolean {
  for (const node of nodes) {
    if (node.slug === slug) return true
    if (node.children && isDescendant(node.children, slug)) return true
  }
  return false
}
