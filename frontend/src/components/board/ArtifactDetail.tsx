/**
 * ArtifactDetail - Unified preview/edit component following PowPow patterns
 *
 * Features:
 * - In-place editing (panel transforms, no separate view)
 * - Type-specific metadata forms
 * - Syntax highlighting for code artifacts
 * - CAS (compare-and-swap) for conflict handling
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { Pencil, Save, AlertTriangle, Download, ExternalLink, Copy, Check, ArrowLeft, ChevronDown, History, RotateCcw, Archive } from 'lucide-react'
import Markdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import { getArtifactIcon, isSpaArtifact } from '../../lib/artifact-icons'
import type { Artifact, ArtifactStatus, ArtifactTreeNode, ArtifactVersion } from '../../types/artifact'
import { McpPropsEditor, type McpProps } from './McpPropsEditor'
import { AgentPropsEditor, type AgentProps } from './AgentPropsEditor'
import { FocusPropsEditor, type FocusProps } from './FocusPropsEditor'
import { AppPropsDisplay, type AppProps } from './AppPropsDisplay'
import { SpaRenderer } from './SpaRenderer'
import { highlightMentions, type ArtifactInfo } from '../../utils'
import { useIsDarkMode } from '../../hooks/useIsDarkMode'

// =============================================================================
// Types
// =============================================================================

interface ArtifactDetailProps {
  artifact: Artifact
  channelId: string
  apiHost: string
  /** Space ID for OAuth flows (system.app artifacts) */
  spaceId?: string
  tree: ArtifactTreeNode[]
  onUpdate: (artifact: Artifact) => void
  onLinkClick: (slug: string) => void
  /** Callback to go back to tree view */
  onBack?: () => void
  /** Callback to archive the artifact (recursive) */
  onArchive?: () => void
}

interface ConflictInfo {
  field: string
  expected: unknown
  actual: unknown
}

interface ValidationViolation {
  path: string
  message: string
  code?: string
}

interface PropsValidationError {
  violations: ValidationViolation[]
  schema?: Record<string, unknown>
}

// =============================================================================
// Constants
// =============================================================================

// Status colors for the badge
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  published: 'bg-green-200 text-green-700 dark:bg-green-900 dark:text-green-300',
  archived: 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  pending: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  in_progress: 'bg-blue-200 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  done: 'bg-green-200 text-green-700 dark:bg-green-900 dark:text-green-300',
  blocked: 'bg-red-200 text-red-700 dark:bg-red-900 dark:text-red-300',
}

// Status options based on type
const DOC_STATUSES: ArtifactStatus[] = ['draft', 'published', 'archived']
const TASK_STATUSES: ArtifactStatus[] = ['pending', 'in_progress', 'done', 'blocked']

// File extensions for syntax highlighting
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'docker',
  '.tf': 'hcl',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'bash',
}

// File extensions that are viewable assets
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']
const PDF_EXTENSION = '.pdf'
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv']

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format a timestamp as relative time (e.g., "2 hours ago") or absolute date for older items.
 */
function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`

  // For older items, show date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// =============================================================================
// Main Component
// =============================================================================

export function ArtifactDetail({
  artifact,
  channelId,
  apiHost,
  spaceId,
  tree,
  onUpdate,
  onLinkClick,
  onBack,
  onArchive,
}: ArtifactDetailProps) {
  // Theme detection for syntax highlighting
  const isDarkMode = useIsDarkMode()

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editTldr, setEditTldr] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editStatus, setEditStatus] = useState<ArtifactStatus>('draft')
  const [editParentSlug, setEditParentSlug] = useState('')

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  const [propsValidationError, setPropsValidationError] = useState<PropsValidationError | null>(null)
  const [copied, setCopied] = useState(false)

  // Version history state
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [versionData, setVersionData] = useState<ArtifactVersion | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  // Fetch version content when a historical version is selected
  useEffect(() => {
    if (!selectedVersion || !channelId) {
      setVersionData(null)
      return
    }

    async function fetchVersion() {
      setVersionLoading(true)
      setError(null)
      try {
        const response = await apiFetch(
          `${apiHost}/channels/${channelId}/artifacts/${artifact.slug}/versions/${selectedVersion}`
        )
        if (!response.ok) {
          throw new Error('Failed to load version')
        }
        const data = await response.json()
        setVersionData(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load version')
        setVersionData(null)
      } finally {
        setVersionLoading(false)
      }
    }

    fetchVersion()
  }, [selectedVersion, channelId, apiHost, artifact.slug])

  // Clear version selection when artifact changes
  useEffect(() => {
    setSelectedVersion(null)
    setVersionData(null)
  }, [artifact.slug])

  // Check if viewing a historical version
  const isViewingHistory = selectedVersion !== null && versionData !== null

  // Asset detection
  const { isAsset, isImage, isPdf, isAudio, isVideo } = isAssetSlug(artifact.slug)
  const assetUrl = `${apiHost}/channels/${channelId}/assets/${artifact.slug}`

  // Code detection
  const isInteractiveApp = artifact.type === 'code' && isSpaArtifact(artifact.slug)
  const isCodeArtifact = (artifact.type === 'code' || hasCodeExtension(artifact.slug)) && !isInteractiveApp
  const codeLanguage = getLanguageFromSlug(artifact.slug)

  // Get available parent options
  const parentOptions = getParentOptions(tree, artifact.slug)

  // Build artifact map for mention highlighting (title lookup)
  const artifactMap = useMemo(() => buildArtifactMap(tree), [tree])

  // Get status options based on type
  const statusOptions = artifact.type === 'task' ? TASK_STATUSES : DOC_STATUSES

  // Enter edit mode
  const startEditing = useCallback(() => {
    setEditTitle(artifact.title || '')
    setEditTldr(artifact.tldr)
    setEditContent(artifact.content)
    setEditStatus(artifact.status)
    setEditParentSlug(artifact.parentSlug || '')
    setIsEditing(true)
    setError(null)
    setConflict(null)
  }, [artifact])

  // Cancel editing
  const cancelEditing = useCallback(() => {
    setIsEditing(false)
    setError(null)
    setConflict(null)
  }, [])

  // Build CAS changes array (metadata only, not content)
  const buildChanges = useCallback(() => {
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []

    if (editTitle !== (artifact.title || '')) {
      changes.push({ field: 'title', oldValue: artifact.title, newValue: editTitle || undefined })
    }
    if (editTldr !== artifact.tldr) {
      changes.push({ field: 'tldr', oldValue: artifact.tldr, newValue: editTldr })
    }
    // Note: content is handled separately via the edit endpoint
    if (editStatus !== artifact.status) {
      changes.push({ field: 'status', oldValue: artifact.status, newValue: editStatus })
    }
    if (editParentSlug !== (artifact.parentSlug || '')) {
      changes.push({ field: 'parentSlug', oldValue: artifact.parentSlug, newValue: editParentSlug || null })
    }

    return changes
  }, [artifact, editTitle, editTldr, editStatus, editParentSlug])

  // Check if content has changed
  const hasContentChanged = useCallback(() => {
    return editContent !== artifact.content
  }, [artifact.content, editContent])

  // Save changes
  const saveChanges = async () => {
    const changes = buildChanges()
    const contentChanged = hasContentChanged()

    if (changes.length === 0 && !contentChanged) {
      setIsEditing(false)
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
            new_string: editContent,
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

      onUpdate(updatedArtifact)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // Handle MCP props updates (inline, no edit mode needed)
  const handlePropsUpdate = async (newProps: Record<string, unknown>) => {
    setSaving(true)
    setPropsValidationError(null)
    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{
            field: 'props',
            oldValue: artifact.props,
            newValue: newProps,
          }],
          sender: 'user',
        }),
      })

      if (response.status === 400) {
        const data = await response.json().catch(() => ({}))
        if (data.violations && Array.isArray(data.violations)) {
          setPropsValidationError({
            violations: data.violations,
            schema: data.schema,
          })
          return
        }
        throw new Error(data.error || 'Invalid props')
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update props')
      }

      const data = await response.json()
      onUpdate(data.artifact)
      setPropsValidationError(null)
    } catch (e) {
      console.error('Failed to update props:', e)
      setError(e instanceof Error ? e.message : 'Failed to update props')
    } finally {
      setSaving(false)
    }
  }

  // Copy content to clipboard
  const copyContent = async () => {
    await navigator.clipboard.writeText(artifact.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Handle inline status change (not in edit mode)
  const handleStatusChange = async (newStatus: ArtifactStatus) => {
    // Skip if status hasn't actually changed
    if (newStatus === artifact.status) return

    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ field: 'status', oldValue: artifact.status, newValue: newStatus }],
          sender: 'user',
        }),
      })

      if (response.status === 409) {
        const data = await response.json()
        setConflict(data.conflict)
        return
      }

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update status')
      }

      const data = await response.json()
      onUpdate(data.artifact)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = buildChanges().length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border space-y-1">
        {/* Row 1: Back + Icon + Title + Status */}
        <div className="flex items-center gap-2">
          {/* Back button */}
          {onBack && (
            <button
              onClick={onBack}
              className="flex-shrink-0 p-1 -ml-1 rounded hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground"
              title="Back to tree"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {/* Icon + Title */}
          {isEditing ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Title (optional)"
              className="flex-1 min-w-0 px-2 py-1 text-sm font-medium bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {(() => {
                const Icon = getArtifactIcon(artifact)
                return <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
              })()}
              <span className="font-semibold text-sm text-foreground truncate">
                {artifact.title || artifact.slug}
              </span>
            </div>
          )}
          {/* Status dropdown */}
          <StatusDropdown
            status={isEditing ? editStatus : artifact.status}
            options={statusOptions}
            onChange={isEditing ? setEditStatus : handleStatusChange}
            disabled={saving}
          />
          {/* Version dropdown - only show if artifact has versions and not editing */}
          {!isEditing && artifact.versions && artifact.versions.length > 0 && (
            <VersionDropdown
              versions={artifact.versions}
              selectedVersion={selectedVersion}
              onSelectVersion={setSelectedVersion}
              loading={versionLoading}
            />
          )}
        </div>

        {/* Row 2: Path + Action icons */}
        <div className="flex items-center gap-2">
          {/* Path breadcrumb */}
          <div className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
            {(() => {
              const pathSegments = getArtifactPath(tree, artifact.slug) || [artifact.slug]
              return pathSegments.join(' / ')
            })()}
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {isEditing ? (
              <>
                <button
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={cancelEditing}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors",
                    hasChanges && !saving
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-secondary text-muted-foreground cursor-not-allowed"
                  )}
                  onClick={saveChanges}
                  disabled={!hasChanges || saving}
                >
                  <Save className="w-3 h-3" />
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </>
            ) : (
              <>
                {!isAsset && (
                  <button
                    className="p-1 rounded hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground"
                    onClick={copyContent}
                    title="Copy content"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                )}
                <button
                  className={cn(
                    "p-1 rounded transition-colors",
                    isViewingHistory
                      ? "text-muted-foreground/50 cursor-not-allowed"
                      : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                  )}
                  onClick={isViewingHistory ? undefined : startEditing}
                  title={isViewingHistory ? "Cannot edit historical version" : "Edit"}
                  disabled={isViewingHistory}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {onArchive && (
                  <button
                    className={cn(
                      "p-1 rounded transition-colors",
                      isViewingHistory
                        ? "text-muted-foreground/50 cursor-not-allowed"
                        : "hover:bg-secondary/50 text-muted-foreground hover:text-destructive"
                    )}
                    onClick={isViewingHistory ? undefined : onArchive}
                    title={isViewingHistory ? "Cannot archive historical version" : "Archive"}
                    disabled={isViewingHistory}
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Historical version banner */}
      {isViewingHistory && (
        <HistoricalVersionBanner
          versionName={selectedVersion!}
          onViewCurrent={() => setSelectedVersion(null)}
        />
      )}

      {/* Error display */}
      {error && (
        <div className="px-3 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Conflict dialog */}
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onOverwrite={saveChanges}
          onReload={() => window.location.reload()}
          onContinue={() => setConflict(null)}
        />
      )}

      {/* Props validation errors */}
      {propsValidationError && (
        <ValidationErrorDisplay
          violations={propsValidationError.violations}
          onDismiss={() => setPropsValidationError(null)}
        />
      )}

      {/* TLDR section */}
      <div className="px-3 py-2 border-b border-border bg-secondary/20">
        {isEditing ? (
          <textarea
            value={editTldr}
            onChange={(e) => setEditTldr(e.target.value)}
            placeholder="Brief summary (required)"
            className="w-full px-2 py-1.5 text-sm bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            rows={2}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {isViewingHistory ? versionData!.tldr : artifact.tldr}
          </p>
        )}
      </div>

      {/* Type-specific metadata (MCP props, Agent props, Focus props) */}
      {artifact.type === 'system.mcp' && (
        <div className="px-3 py-3 border-b border-border">
          {saving && (
            <div className="text-xs text-muted-foreground mb-2">Saving...</div>
          )}
          <McpPropsEditor
            props={(artifact.props as unknown as McpProps) || { transport: 'stdio' as const }}
            onChange={(updates) => {
              const currentProps = (artifact.props as unknown as McpProps) || { transport: 'stdio' as const }
              handlePropsUpdate({ ...currentProps, ...updates } as unknown as Record<string, unknown>)
            }}
            channel={channelId}
            mcpSlug={artifact.slug}
          />
        </div>
      )}

      {artifact.type === 'system.agent' && (
        <div className="px-3 py-3 border-b border-border">
          {saving && (
            <div className="text-xs text-muted-foreground mb-2">Saving...</div>
          )}
          <AgentPropsEditor
            props={(artifact.props as unknown as AgentProps) || { engine: 'claude' }}
            onChange={(updates) => {
              const currentProps = (artifact.props as unknown as AgentProps) || { engine: 'claude' }
              handlePropsUpdate({ ...currentProps, ...updates } as unknown as Record<string, unknown>)
            }}
            channelId={channelId}
            apiHost={apiHost}
          />
        </div>
      )}

      {artifact.type === 'system.focus' && (
        <div className="px-3 py-3 border-b border-border">
          {saving && (
            <div className="text-xs text-muted-foreground mb-2">Saving...</div>
          )}
          <FocusPropsEditor
            props={(artifact.props as unknown as FocusProps) || { agents: [] }}
            onChange={(updates) => {
              const currentProps = (artifact.props as unknown as FocusProps) || { agents: [] }
              handlePropsUpdate({ ...currentProps, ...updates } as unknown as Record<string, unknown>)
            }}
            apiHost={apiHost}
          />
        </div>
      )}

      {artifact.type === 'system.app' && spaceId && (
        <div className="px-3 py-3 border-b border-border">
          {saving && (
            <div className="text-xs text-muted-foreground mb-2">Saving...</div>
          )}
          <AppPropsDisplay
            props={(artifact.props as unknown as AppProps) || { provider: '' }}
            secrets={artifact.secrets}
            slug={artifact.slug}
            spaceId={spaceId}
            channelId={channelId}
            onStatusChange={() => {
              // Refetch artifact to get updated secrets metadata
              apiFetch(`${apiHost}/channels/${channelId}/artifacts/${artifact.slug}`)
                .then(res => res.json())
                .then(data => onUpdate(data))
                .catch(console.error)
            }}
          />
        </div>
      )}

      {/* Parent selection (edit mode only) */}
      {isEditing && (
        <div className="px-3 py-2 border-b border-border">
          <label className="block text-xs text-muted-foreground mb-1">Parent</label>
          <select
            value={editParentSlug}
            onChange={(e) => setEditParentSlug(e.target.value)}
            className="w-full px-2 py-1.5 text-sm bg-secondary rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">(root level)</option>
            {parentOptions.map((opt) => (
              <option key={opt.slug} value={opt.slug}>
                {opt.path}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Content area */}
      <div className={cn("flex-1 min-h-0", isInteractiveApp ? "overflow-hidden flex flex-col" : "overflow-y-auto")}>
        {versionLoading ? (
          <div className="flex items-center justify-center h-20">
            <span className="text-sm text-muted-foreground">Loading version...</span>
          </div>
        ) : isEditing ? (
          <div className="h-full p-3">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder={isCodeArtifact ? 'Code content...' : 'Markdown content...'}
              className={cn(
                "w-full h-full px-3 py-2 text-sm bg-secondary rounded border border-border",
                "focus:outline-none focus:ring-1 focus:ring-primary resize-none",
                isCodeArtifact && "font-mono"
              )}
            />
          </div>
        ) : isInteractiveApp ? (
          <SpaRenderer
            content={isViewingHistory ? versionData!.content : artifact.content}
            channel={channelId}
            slug={artifact.slug}
          />
        ) : isAsset ? (
          <div className="p-3">
            <AssetPreview
              slug={artifact.slug}
              url={assetUrl}
              isImage={isImage}
              isPdf={isPdf}
              isAudio={isAudio}
              isVideo={isVideo}
            />
          </div>
        ) : isCodeArtifact ? (
          <CodeContent content={isViewingHistory ? versionData!.content : artifact.content} language={codeLanguage} isDarkMode={isDarkMode} />
        ) : (
          <div className="p-3">
            <ArtifactContent
              content={isViewingHistory ? versionData!.content : artifact.content}
              onLinkClick={onLinkClick}
              artifacts={artifactMap}
              isDarkMode={isDarkMode}
            />
          </div>
        )}
      </div>

      {/* Metadata footer */}
      {!isEditing && (
        <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground space-y-1">
          {/* Created/Updated info */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span>Created by <span className="text-foreground">@{artifact.createdBy}</span> · {formatRelativeTime(artifact.createdAt)}</span>
            {artifact.updatedAt && artifact.updatedAt !== artifact.createdAt && (
              <span>Updated {formatRelativeTime(artifact.updatedAt)}</span>
            )}
          </div>
          {/* Assignees */}
          {(artifact.assignees?.length ?? 0) > 0 && (
            <div>Assignees: {artifact.assignees?.map(a => `@${a}`).join(', ')}</div>
          )}
          {/* Labels */}
          {(artifact.labels?.length ?? 0) > 0 && (
            <div>Labels: {artifact.labels?.join(', ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Status dropdown with color-coded pill and popover menu.
 */
function StatusDropdown({
  status,
  options,
  onChange,
  disabled,
}: {
  status: ArtifactStatus
  options: ArtifactStatus[]
  onChange: (status: ArtifactStatus) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors",
          STATUS_COLORS[status] || STATUS_COLORS.draft,
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:opacity-80"
        )}
      >
        <span>{status.replace('_', ' ')}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {/* Dropdown menu */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          {/* Menu */}
          <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded shadow-lg py-1 min-w-[120px]">
            {options.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                }}
                className={cn(
                  "w-full px-3 py-1.5 text-xs text-left hover:bg-secondary transition-colors flex items-center gap-2",
                  opt === status && "bg-secondary/50"
                )}
              >
                <span className={cn(
                  "w-2 h-2 rounded-full",
                  STATUS_COLORS[opt]?.split(' ')[0] || 'bg-gray-200'
                )} />
                <span>{opt.replace('_', ' ')}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Version dropdown for viewing artifact version history.
 * Shows "Current" when viewing latest, or version name when viewing history.
 */
function VersionDropdown({
  versions,
  selectedVersion,
  onSelectVersion,
  loading,
}: {
  versions: string[]
  selectedVersion: string | null
  onSelectVersion: (version: string | null) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors",
          selectedVersion
            ? "bg-amber-200/50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
          loading && "opacity-50 cursor-wait"
        )}
        title="Version history"
      >
        <History className="w-3 h-3" />
        <span>{selectedVersion || 'Current'}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {/* Dropdown menu */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          {/* Menu */}
          <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded shadow-lg py-1 min-w-[160px] max-h-[300px] overflow-y-auto">
            {/* Current option */}
            <button
              onClick={() => {
                onSelectVersion(null)
                setOpen(false)
              }}
              className={cn(
                "w-full px-3 py-1.5 text-xs text-left hover:bg-secondary transition-colors flex items-center gap-2",
                !selectedVersion && "bg-secondary/50"
              )}
            >
              <span className="font-medium">Current</span>
            </button>
            {/* Divider */}
            <div className="border-t border-border my-1" />
            {/* Version list (newest first) */}
            {[...versions].reverse().map((version) => (
              <button
                key={version}
                onClick={() => {
                  onSelectVersion(version)
                  setOpen(false)
                }}
                className={cn(
                  "w-full px-3 py-1.5 text-xs text-left hover:bg-secondary transition-colors",
                  version === selectedVersion && "bg-secondary/50"
                )}
              >
                <span>{version}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Banner shown when viewing a historical version (not current).
 * Amber/yellow tint to indicate non-current state without being alarming.
 */
function HistoricalVersionBanner({
  versionName,
  onViewCurrent,
}: {
  versionName: string
  onViewCurrent: () => void
}) {
  return (
    <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <History className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">
            Viewing <span className="font-medium">{versionName}</span> (not current)
          </span>
        </div>
        <button
          onClick={onViewCurrent}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-amber-200/50 dark:hover:bg-amber-800/50 text-amber-700 dark:text-amber-300 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          View Current
        </button>
      </div>
    </div>
  )
}

function ConflictDialog({
  conflict,
  onOverwrite,
  onReload,
  onContinue,
}: {
  conflict: ConflictInfo
  onOverwrite: () => void
  onReload: () => void
  onContinue: () => void
}) {
  return (
    <div className="px-3 py-3 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-sm text-yellow-800 dark:text-yellow-200">Edit Conflict</div>
          <div className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
            The field "{conflict.field}" was modified by someone else while you were editing.
          </div>
          <div className="flex gap-2 mt-2">
            <button
              className="px-2 py-1 text-xs bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200 rounded hover:bg-yellow-300 dark:hover:bg-yellow-700"
              onClick={onOverwrite}
            >
              Overwrite
            </button>
            <button
              className="px-2 py-1 text-xs text-yellow-700 dark:text-yellow-300 hover:text-yellow-900 dark:hover:text-yellow-100"
              onClick={onReload}
            >
              Reload
            </button>
            <button
              className="px-2 py-1 text-xs text-yellow-700 dark:text-yellow-300 hover:text-yellow-900 dark:hover:text-yellow-100"
              onClick={onContinue}
            >
              Continue Editing
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ValidationErrorDisplay({
  violations,
  onDismiss,
}: {
  violations: ValidationViolation[]
  onDismiss: () => void
}) {
  return (
    <div className="px-3 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-sm text-red-800 dark:text-red-200">Validation Error</div>
          <ul className="text-xs text-red-700 dark:text-red-300 mt-1 space-y-1">
            {violations.map((v, i) => (
              <li key={i}>
                <span className="font-mono">{v.path}</span>: {v.message}
              </li>
            ))}
          </ul>
          <button
            className="px-2 py-1 mt-2 text-xs text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-100"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

function CodeContent({ content, language, isDarkMode }: { content: string; language: string; isDarkMode: boolean }) {
  const codeTheme = isDarkMode ? oneDark : oneLight

  return (
    <div className="text-sm">
      <SyntaxHighlighter
        language={language}
        style={codeTheme}
        customStyle={{
          margin: 0,
          padding: '1rem',
          borderRadius: 0,
          fontSize: '0.8125rem',
          lineHeight: '1.5',
        }}
        showLineNumbers
      >
        {content}
      </SyntaxHighlighter>
    </div>
  )
}

interface ArtifactContentProps {
  content: string
  onLinkClick: (slug: string) => void
  artifacts?: Map<string, ArtifactInfo>
  isDarkMode: boolean
}

function ArtifactContent({ content, onLinkClick, artifacts, isDarkMode }: ArtifactContentProps) {
  const codeTheme = isDarkMode ? oneDark : oneLight

  // Process children to highlight @mentions and [[artifact]] links
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    if (typeof children === 'string') {
      return highlightMentions(children, { onArtifactClick: onLinkClick, artifacts })
    }
    if (Array.isArray(children)) {
      return children.map((child, i) => {
        if (typeof child === 'string') {
          return <span key={i}>{highlightMentions(child, { onArtifactClick: onLinkClick, artifacts })}</span>
        }
        return child
      })
    }
    return children
  }

  // Custom components to handle @mentions and [[artifact]] links within markdown
  const markdownComponents: Components = {
    p: ({ children }) => <p>{processChildren(children)}</p>,
    li: ({ children }) => <li>{processChildren(children)}</li>,
    td: ({ children }) => <td>{processChildren(children)}</td>,
    th: ({ children }) => <th>{processChildren(children)}</th>,
    // Syntax highlighting for code blocks
    code: ({ className, children, node, ...props }) => {
      const match = /language-(\w+)/.exec(className || '')
      // Check if this is a code block: has language class, or has newlines
      const codeString = String(children)
      const hasNewlines = codeString.includes('\n')
      const isCodeBlock = match || hasNewlines

      if (!isCodeBlock) {
        // Inline code - render as styled span
        return (
          <code className="bg-secondary px-1.5 py-0.5 text-sm font-mono rounded" {...props}>
            {children}
          </code>
        )
      }

      // Code block - use syntax highlighter
      const language = match ? match[1] : 'text'
      return (
        <div className="not-prose">
          <SyntaxHighlighter
            style={codeTheme}
            language={language}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: '1rem',
              fontSize: '13px',
              lineHeight: '1.2',
              borderRadius: '0.25rem',
            }}
          >
            {codeString.replace(/\n$/, '')}
          </SyntaxHighlighter>
        </div>
      )
    },
    // Override pre to avoid double wrapping
    pre: ({ children }) => <>{children}</>,
  }

  return (
    <Markdown
      className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
    >
      {content}
    </Markdown>
  )
}

function AssetPreview({ slug, url, isImage, isPdf, isAudio, isVideo }: { slug: string; url: string; isImage: boolean; isPdf: boolean; isAudio: boolean; isVideo: boolean }) {
  if (isImage) {
    return (
      <div className="space-y-3">
        <img
          src={url}
          alt={slug}
          className="max-w-full rounded border border-border"
          loading="lazy"
        />
        <div className="flex gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <ExternalLink className="w-3 h-3" />
            Open
          </a>
          <a
            href={url}
            download={slug}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
      </div>
    )
  }

  if (isPdf) {
    return (
      <div className="space-y-3">
        <div className="flex gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <ExternalLink className="w-3 h-3" />
            Open PDF
          </a>
          <a
            href={url}
            download={slug}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
        <iframe
          src={url}
          title={slug}
          className="w-full h-80 border border-border rounded"
        />
      </div>
    )
  }

  if (isAudio) {
    return (
      <div className="space-y-3">
        <audio
          src={url}
          controls
          className="w-full"
          preload="metadata"
        >
          Your browser does not support the audio element.
        </audio>
        <div className="flex gap-2">
          <a
            href={url}
            download={slug}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
      </div>
    )
  }

  if (isVideo) {
    return (
      <div className="space-y-3">
        <video
          src={url}
          controls
          className="w-full max-h-96 rounded border border-border"
          preload="metadata"
        >
          Your browser does not support the video element.
        </video>
        <div className="flex gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <ExternalLink className="w-3 h-3" />
            Open
          </a>
          <a
            href={url}
            download={slug}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
      </div>
    )
  }

  return null
}

// =============================================================================
// Helper functions
// =============================================================================

function isAssetSlug(slug: string | undefined): { isAsset: boolean; isImage: boolean; isPdf: boolean; isAudio: boolean; isVideo: boolean } {
  if (!slug) return { isAsset: false, isImage: false, isPdf: false, isAudio: false, isVideo: false }
  const lower = slug.toLowerCase()
  const isImage = IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
  const isPdf = lower.endsWith(PDF_EXTENSION)
  const isAudio = AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext))
  const isVideo = VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext))
  return { isAsset: isImage || isPdf || isAudio || isVideo, isImage, isPdf, isAudio, isVideo }
}

function hasCodeExtension(slug: string): boolean {
  const lower = slug.toLowerCase()
  return Object.keys(EXT_TO_LANG).some(ext => lower.endsWith(ext))
}

function getLanguageFromSlug(slug: string): string {
  const lower = slug.toLowerCase()
  for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
    if (lower.endsWith(ext)) return lang
  }
  return 'text'
}

interface ParentOption {
  slug: string
  path: string
}

function getParentOptions(nodes: ArtifactTreeNode[], excludeSlug: string, prefix = ''): ParentOption[] {
  const options: ParentOption[] = []

  for (const node of nodes) {
    if (node.slug === excludeSlug) continue

    const path = prefix ? `${prefix}/${node.slug}` : node.slug
    options.push({ slug: node.slug, path })

    if (node.children) {
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

/**
 * Build the full path for an artifact by traversing the tree.
 * Returns path segments (e.g., ['parent', 'child', 'artifact-slug'])
 */
function getArtifactPath(nodes: ArtifactTreeNode[], targetSlug: string, path: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.slug === targetSlug) {
      return [...path, node.slug]
    }
    if (node.children) {
      const result = getArtifactPath(node.children, targetSlug, [...path, node.slug])
      if (result) return result
    }
  }
  return null
}

/**
 * Flatten the artifact tree into a Map<slug, ArtifactInfo> for mention highlighting.
 */
function buildArtifactMap(nodes: ArtifactTreeNode[]): Map<string, ArtifactInfo> {
  const map = new Map<string, ArtifactInfo>()

  function traverse(nodeList: ArtifactTreeNode[]) {
    for (const node of nodeList) {
      map.set(node.slug.toLowerCase(), {
        slug: node.slug,
        title: node.title,
        type: node.type,
        encoding: node.encoding,
        contentType: node.contentType,
      })
      if (node.children) {
        traverse(node.children)
      }
    }
  }

  traverse(nodes)
  return map
}
