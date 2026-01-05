import { useState, useCallback } from 'react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import type { Artifact, ArtifactType, ArtifactStatus, ArtifactTreeNode } from '../../types/artifact'
import { McpPropsEditor, type McpProps } from './McpPropsEditor'
import { AgentPropsEditor, type AgentProps } from './AgentPropsEditor'
import { FocusPropsEditor, type FocusProps } from './FocusPropsEditor'

interface ArtifactCreateProps {
  channelId: string
  apiHost: string
  tree: ArtifactTreeNode[]
  /** Initial type to pre-select (from header dropdown) */
  initialType?: ArtifactType
  onSuccess: (artifact: Artifact) => void
  onCancel: () => void
}

// Available types for creation (all types are user-creatable)
const ARTIFACT_TYPES: { value: ArtifactType; label: string }[] = [
  { value: 'doc', label: 'Document' },
  { value: 'task', label: 'Task' },
  { value: 'decision', label: 'Decision' },
  { value: 'code', label: 'Code' },
  { value: 'knowledgebase', label: 'Knowledge Base' },
  { value: 'system.mcp', label: 'MCP Server' },
  { value: 'system.agent', label: 'Agent' },
  { value: 'system.focus', label: 'Focus' },
  { value: 'system.playbook', label: 'Playbook' },
]

// Default status based on type
const DEFAULT_STATUS: Record<ArtifactType, ArtifactStatus> = {
  doc: 'draft',
  task: 'pending',
  decision: 'draft',
  code: 'draft',
  knowledgebase: 'published',
  'system.mcp': 'published',
  'system.agent': 'published',
  'system.focus': 'published',
  'system.playbook': 'published',
}

// Slug validation regex
const SLUG_REGEX = /^[a-z0-9-]+(\.[a-z0-9]+)*$/

export function ArtifactCreate({
  channelId,
  apiHost,
  tree,
  initialType,
  onSuccess,
  onCancel,
}: ArtifactCreateProps) {
  // Form state
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ArtifactType>(initialType || 'doc')
  const [tldr, setTldr] = useState('')
  const [content, setContent] = useState('')
  const [parentSlug, setParentSlug] = useState('')

  // Type-specific props state
  const [mcpProps, setMcpProps] = useState<McpProps>({ transport: 'stdio' })
  const [agentProps, setAgentProps] = useState<AgentProps>({ engine: 'claude' })
  const [focusProps, setFocusProps] = useState<FocusProps>({ agents: [] })

  // Whether type is locked (when initialType provided)
  const typeLocked = !!initialType

  // UI state
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slugError, setSlugError] = useState<string | null>(null)

  // Get available parent options
  const parentOptions = getParentOptions(tree)

  // Validate slug on change
  const handleSlugChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, '-')
    setSlug(normalized)

    if (normalized && !SLUG_REGEX.test(normalized)) {
      setSlugError('Use lowercase letters, numbers, and hyphens only')
    } else {
      setSlugError(null)
    }
  }

  // Handlers for type-specific props
  const handleMcpPropsChange = useCallback((updates: Partial<McpProps>) => {
    setMcpProps((prev) => ({ ...prev, ...updates }))
  }, [])

  const handleAgentPropsChange = useCallback((updates: Partial<AgentProps>) => {
    setAgentProps((prev) => ({ ...prev, ...updates }))
  }, [])

  const handleFocusPropsChange = useCallback((updates: Partial<FocusProps>) => {
    setFocusProps((prev) => ({ ...prev, ...updates }))
  }, [])

  // Get current props based on type
  const getCurrentProps = () => {
    switch (type) {
      case 'system.mcp':
        return mcpProps
      case 'system.agent':
        return agentProps
      case 'system.focus':
        // Validate at least one agent selected
        return focusProps.agents.length > 0 ? focusProps : null
      default:
        return undefined
    }
  }

  // Check if type-specific validation passes
  const isTypePropsValid = () => {
    switch (type) {
      case 'system.focus':
        return focusProps.agents.length > 0
      default:
        return true
    }
  }

  // Check if form is valid
  const isValid = slug && !slugError && tldr && type && isTypePropsValid()

  const handleCreate = async () => {
    if (!isValid) return

    setCreating(true)
    setError(null)

    try {
      // Get type-specific props
      const props = getCurrentProps()

      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          type,
          title: title || undefined,
          tldr,
          content: content || `# ${title || slug}\n\n${tldr}`,
          parentSlug: parentSlug || undefined,
          status: DEFAULT_STATUS[type],
          props: props || undefined,
          createdBy: 'user', // TODO: Get from auth context
        }),
      })

      if (response.status === 409) {
        setError(`An artifact with slug "${slug}" already exists`)
        return
      }

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to create artifact')
      }

      const data = await response.json()
      onSuccess(data.artifact)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium text-sm text-foreground">Create Artifact</span>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onCancel}
            disabled={creating}
          >
            Cancel
          </button>
          <button
            className={cn(
              "px-2 py-1 text-xs rounded transition-colors",
              isValid && !creating
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-secondary text-muted-foreground cursor-not-allowed"
            )}
            onClick={handleCreate}
            disabled={!isValid || creating}
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="px-3 py-2 bg-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Slug */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Slug <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            className={cn(
              "w-full px-2 py-1.5 text-sm bg-background rounded border focus:outline-none focus:ring-1",
              slugError
                ? "border-red-500 focus:ring-red-500"
                : "border-border focus:ring-primary"
            )}
            placeholder="my-artifact-slug"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            autoFocus
          />
          {slugError ? (
            <p className="text-xs text-red-500 mt-1">{slugError}</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              Lowercase, alphanumeric, hyphens (e.g., "api-spec" or "auth.test.ts")
            </p>
          )}
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Title</label>
          <input
            type="text"
            className="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Optional display name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Type <span className="text-red-500">*</span>
            {typeLocked && <span className="ml-2 text-primary">(locked)</span>}
          </label>
          <select
            className={cn(
              "w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary",
              typeLocked && "opacity-60 cursor-not-allowed"
            )}
            value={type}
            onChange={(e) => setType(e.target.value as ArtifactType)}
            disabled={typeLocked}
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* TLDR */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            TLDR <span className="text-red-500">*</span>
          </label>
          <textarea
            className="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            rows={2}
            placeholder="Brief summary (1-3 sentences)"
            value={tldr}
            onChange={(e) => setTldr(e.target.value)}
          />
        </div>

        {/* Content */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Content</label>
          <textarea
            className="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-none"
            rows={6}
            placeholder="Markdown content (optional, will be auto-generated if empty)"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>

        {/* Type-specific props editors */}
        {type === 'system.mcp' && (
          <div className="border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase mb-3">
              MCP Server Configuration
            </h3>
            <McpPropsEditor
              props={mcpProps}
              onChange={handleMcpPropsChange}
            />
          </div>
        )}

        {type === 'system.agent' && (
          <div className="border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase mb-3">
              Agent Configuration
            </h3>
            <AgentPropsEditor
              props={agentProps}
              onChange={handleAgentPropsChange}
              channelId={channelId}
              apiHost={apiHost}
            />
          </div>
        )}

        {type === 'system.focus' && (
          <div className="border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase mb-3">
              Focus Configuration
            </h3>
            <FocusPropsEditor
              props={focusProps}
              onChange={handleFocusPropsChange}
              apiHost={apiHost}
            />
            {focusProps.agents.length === 0 && (
              <p className="text-xs text-destructive mt-2">
                At least one starting agent is required
              </p>
            )}
          </div>
        )}

        {/* Parent */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Parent</label>
          <select
            className="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
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
 */
function getParentOptions(
  nodes: ArtifactTreeNode[],
  prefix = ''
): ParentOption[] {
  const options: ParentOption[] = []

  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.slug}` : node.slug
    options.push({ slug: node.slug, path })

    if (node.children) {
      options.push(...getParentOptions(node.children, path))
    }
  }

  return options
}
