import React, { useEffect, useState, useRef } from 'react'
import { ArrowLeft, FileText, Clock, User, Tag, Users, History, ChevronDown, Copy, Check, Pencil, X, Save, Archive, SquarePlay, FileAudio, File, Download, Plug, Plus } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@/lib/utils'
import { NAME_THEMES, NameTheme } from '@/lib/constants'
import { getArtifactIcon, getArtifactTypeLabel, isSpaArtifact, isBinaryAssetByEncoding } from '@/lib/artifact-icons'
import { renderBinaryAsset } from '@/lib/binary-renderers'
import { Artifact, ArtifactVersion, Status, ArtifactSummary } from '@/types'
import { fetchArtifact, fetchArtifactVersions, updateArtifact, fetchBackends, BackendInfo, fetchArtifacts } from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EditableField } from '@/components/ui/editable-field'
import { EditableSelect } from '@/components/ui/editable-select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { KeyValueEditor, KeyValuePair } from '@/components/ui/key-value-editor'
import { StringListEditor } from '@/components/ui/string-list-editor'
import { OAuthConnectButton } from '@/components/ui/oauth-connect-button'
import { SpaRenderer } from './SpaRenderer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// Map file extensions to Prism language names
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  graphql: 'graphql',
  dockerfile: 'docker',
}

function getLanguageFromSlug(slug: string): string {
  const ext = slug.split('.').pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] || ext : 'text'
}

// Helper to check if artifact is binary (uses shared utility)
function isBinaryAsset(artifact: { encoding?: string }): boolean {
  return isBinaryAssetByEncoding(artifact.encoding)
}

// Binary asset preview component - uses shared renderer system
function BinaryAssetPreview({ channel, slug, contentType }: { channel: string; slug: string; contentType?: string }) {
  const assetUrl = `/boards/${encodeURIComponent(channel)}/${encodeURIComponent(slug)}`

  return (
    <>
      {renderBinaryAsset(
        {
          assetUrl,
          slug,
          contentType,
          title: slug,
        },
        'full'
      )}
    </>
  )
}

// Parse [[slug]] links in text and render as clickable buttons
function parseArtifactLinks(text: string, onNavigate: (slug: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /\[\[([^\]]+)\]\]/g
  let lastIndex = 0
  let match
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const slug = match[1]
    parts.push(
      <button
        key={key++}
        onClick={() => onNavigate(slug)}
        className="inline-flex items-center text-xs font-mono px-1.5 py-0.5 rounded border border-input bg-background hover:bg-secondary hover:text-primary transition-colors"
      >
        [[{slug}]]
      </button>
    )
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length ? parts : [text]
}

interface ArtifactPreviewProps {
  channel: string
  slug: string
  onBack: () => void
  onNavigate: (slug: string) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
}

const STATUS_COLORS: Record<Status, string> = {
  draft: 'bg-yellow-500/20 text-yellow-500',
  published: 'bg-green-500/20 text-green-500',
  archived: 'bg-muted text-muted-foreground',
  pending: 'bg-yellow-500/20 text-yellow-500',
  in_progress: 'bg-blue-500/20 text-blue-500',
  done: 'bg-green-500/20 text-green-500',
  blocked: 'bg-red-500/20 text-red-500',
}

const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Agent props type for system.agent artifacts
interface AgentProps {
  engine?: string
  nameTheme?: NameTheme
  agentName?: string
  model?: string
  mcp?: Array<{ slug: string }>
}

// MCP props type for system.mcp artifacts
type McpTransport = 'stdio' | 'http'
type McpAuthType = 'none' | 'api_key' | 'oauth'

interface McpAuthConfig {
  type: McpAuthType
  provider?: string // e.g., 'sanity', 'github'
  authorizationUrl?: string
  tokenUrl?: string
  scopes?: string[]
  // API Key auth
  header?: string // e.g., 'Authorization: Bearer ${API_KEY}'
}

interface McpProps {
  transport: McpTransport
  // stdio transport fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // http transport fields
  url?: string
  headers?: Record<string, string>
  // Description
  capabilities?: string
  // Authentication (Phase 2)
  auth?: McpAuthConfig
}

// Focus props type for system.focus artifacts
interface FocusProps {
  agents?: string[]
  defaultTagline?: string
  defaultMission?: string
  initialPrompt?: string
}

export function ArtifactPreview({ channel, slug, onBack, onNavigate, editing = false, onEditingChange }: ArtifactPreviewProps) {
  const [artifact, setArtifact] = useState<(Artifact & { versions: string[] }) | null>(null)
  const [versions, setVersions] = useState<ArtifactVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null) // null = current
  const [versionContent, setVersionContent] = useState<{ content: string; tldr: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const wasEditingRef = useRef(false)
  // Track latest version to avoid stale closure issues
  const versionRef = useRef<number>(0)
  // Backends for system.agent engine dropdown
  const [backends, setBackends] = useState<BackendInfo[]>([])
  // Available MCP artifacts for system.agent MCP picker
  const [availableMcps, setAvailableMcps] = useState<ArtifactSummary[]>([])
  // Available agents for system.focus agent selection
  const [availableAgents, setAvailableAgents] = useState<{ slug: string; title: string }[]>([])

  const setEditing = (value: boolean) => {
    onEditingChange?.(value)
  }

  const handleCopy = async () => {
    const content = selectedVersion && versionContent ? versionContent.content : artifact?.content || ''
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleEdit = () => {
    setEditing(true)
  }

  const handleCancelEdit = () => {
    setEditing(false)
    setEditContent('')
  }

  const handleSave = async () => {
    if (!artifact) return
    setSaving(true)
    try {
      const updated = await updateArtifact(channel, slug, {
        content: editContent,
        updatedBy: 'user', // TODO: use actual user name
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        setArtifact({ ...artifact, ...updated, versions: artifact.versions })
        setEditing(false)
      }
    } catch (e: any) {
      alert(e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async () => {
    if (!artifact) return
    try {
      await updateArtifact(channel, slug, {
        status: 'archived',
        updatedBy: 'user', // TODO: use actual user name
      }, versionRef.current)
      onBack()
    } catch (e: any) {
      alert(e.message || 'Failed to archive')
    }
  }

  const handleUpdateTldr = async (newTldr: string) => {
    if (!artifact) return
    try {
      const updated = await updateArtifact(channel, slug, {
        tldr: newTldr,
        updatedBy: 'user',
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        setArtifact({ ...updated, versions: artifact.versions })
      }
    } catch (e: any) {
      alert(e.message || 'Failed to update summary')
    }
  }

  // Update status
  const handleUpdateStatus = async (newStatus: string) => {
    if (!artifact) return
    try {
      const updated = await updateArtifact(channel, slug, {
        status: newStatus,
        updatedBy: 'user',
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        setArtifact({ ...updated, versions: artifact.versions })
      }
    } catch (e: any) {
      alert(e.message || 'Failed to update status')
    }
  }

  // Update props for system.agent artifacts
  const handleUpdateProps = async (propUpdates: Partial<AgentProps>) => {
    if (!artifact) return
    try {
      const currentProps = (artifact.props as AgentProps) || {}
      const newProps = { ...currentProps, ...propUpdates }
      const updated = await updateArtifact(channel, slug, {
        props: newProps,
        updatedBy: 'user',
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        setArtifact({ ...updated, versions: artifact.versions })
      }
    } catch (e: any) {
      alert(e.message || 'Failed to update')
    }
  }

// Update props for system.mcp artifacts
  const handleUpdateMcpProps = async (propUpdates: Partial<McpProps>) => {
    if (!artifact) return
    try {
      const currentProps = (artifact.props as McpProps) || { transport: 'stdio' }
      const newProps = { ...currentProps, ...propUpdates }
      const updated = await updateArtifact(channel, slug, {
        props: newProps,
        updatedBy: 'user',
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        // Re-fetch to get the updated artifact
        const refreshed = await fetchArtifact(channel, slug)
        if (refreshed) {
          setArtifact(refreshed)
        }
      }
    } catch (e: any) {
      alert(e.message || 'Failed to update MCP props')
    }
  }

  // Update props for system.focus artifacts
  const handleUpdateFocusProps = async (propUpdates: Partial<FocusProps>) => {
    if (!artifact) return
    try {
      const currentProps = (artifact.props as FocusProps) || {}
      const newProps = { ...currentProps, ...propUpdates }
      const updated = await updateArtifact(channel, slug, {
        props: newProps,
        updatedBy: 'user',
      }, versionRef.current)
      if (updated) {
        versionRef.current = updated.version
        setArtifact({ ...updated, versions: artifact.versions })
      }
    } catch (e: any) {
      alert(e.message || 'Failed to update')
    }
  }

  // Process children recursively to handle [[slug]] links in text nodes
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    return React.Children.map(children, child => {
      if (typeof child === 'string') {
        return <>{parseArtifactLinks(child, onNavigate)}</>
      }
      if (React.isValidElement(child) && child.props.children) {
        return React.cloneElement(child, {
          ...child.props,
          children: processChildren(child.props.children)
        } as React.HTMLAttributes<HTMLElement>)
      }
      return child
    })
  }

  useEffect(() => {
    setLoading(true)
    setSelectedVersion(null)
    setVersionContent(null)
    Promise.all([
      fetchArtifact(channel, slug),
      fetchArtifactVersions(channel, slug),
    ]).then(([art, vers]) => {
      setArtifact(art)
      if (art) versionRef.current = art.version
      setVersions(vers)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [channel, slug])

  // Initialize edit content when entering edit mode or when artifact loads while in edit mode
  useEffect(() => {
    // Only initialize when transitioning to edit mode (not on every artifact update)
    if (editing && artifact && !wasEditingRef.current) {
      setEditContent(artifact.content || '')
    }
    wasEditingRef.current = editing
  }, [editing, artifact])

  // Fetch backends when viewing a system.agent (for inline editing of engine)
  useEffect(() => {
    if (artifact?.type === 'system.agent') {
      fetchBackends()
        .then(setBackends)
        .catch(err => console.error('Failed to fetch backends:', err))
    }
  }, [artifact?.type])

// Fetch available MCPs when viewing a system.agent (for MCP assignment)
  useEffect(() => {
    if (artifact?.type === 'system.agent') {
      // Fetch MCPs from both current channel and root
      Promise.all([
        fetchArtifacts(channel, { type: 'system.mcp' }),
        channel !== 'root' ? fetchArtifacts('root', { type: 'system.mcp' }) : Promise.resolve([]),
      ])
        .then(([channelMcps, rootMcps]) => {
          // Combine and dedupe (channel takes precedence over root)
          const mcpMap = new Map<string, ArtifactSummary>()
          rootMcps.forEach(mcp => mcpMap.set(mcp.slug, mcp))
          channelMcps.forEach(mcp => mcpMap.set(mcp.slug, mcp))
          setAvailableMcps(Array.from(mcpMap.values()))
        })
        .catch(err => console.error('Failed to fetch MCPs:', err))
    }
  }, [artifact?.type, channel])

  // Fetch available agents when viewing a system.focus (for agent selection)
  useEffect(() => {
    if (artifact?.type === 'system.focus') {
      fetchArtifacts('root', { type: 'system.agent' })
        .then(agents => setAvailableAgents(agents.map(a => ({ slug: a.slug, title: a.title || a.slug }))))
        .catch(err => console.error('Failed to fetch agents:', err))
    }
  }, [artifact?.type])

  // Fetch version content when a version is selected
  useEffect(() => {
    if (!selectedVersion || !channel || !slug) {
      setVersionContent(null)
      return
    }
    fetch(`/api/channels/${encodeURIComponent(channel)}/artifacts/${encodeURIComponent(slug)}/versions/${encodeURIComponent(selectedVersion)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setVersionContent({ content: data.content, tldr: data.tldr })
        }
      })
      .catch(() => setVersionContent(null))
  }, [selectedVersion, channel, slug])

  // ESC to close preview (when not in edit mode - edit mode handles its own ESC)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) {
        onBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editing, onBack])

  // Content to display (version or current)
  const displayContent = selectedVersion && versionContent ? versionContent.content : artifact?.content || ''
  const displayTldr = selectedVersion && versionContent ? versionContent.tldr : artifact?.tldr || ''

  const Icon = artifact ? getArtifactIcon(artifact) : FileText

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading...
      </div>
    )
  }

  if (!artifact) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="px-3 py-2 border-b">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 -ml-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Artifact not found
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with back button */}
      <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 -ml-2 shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {artifact.title || artifact.slug}
          </div>
          <div className="text-[10px] text-muted-foreground truncate">
            {artifact.path}
          </div>
        </div>
        {/* Version selector dropdown */}
        {versions.length > 0 && (() => {
          const sortedVersions = [...versions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          const latestVersion = sortedVersions[0]
          const displayVersion = selectedVersion || latestVersion?.version
          return (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 shrink-0 text-xs">
                  <History className="h-3.5 w-3.5" />
                  {displayVersion}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-0">
                <div className="max-h-64 overflow-y-auto">
                  {sortedVersions.map((v, i) => (
                    <button
                      key={v.version}
                      onClick={() => setSelectedVersion(v.version)}
                      className={cn(
                        'w-full text-left px-3 py-2 text-sm hover:bg-secondary/50',
                        i > 0 && 'border-t border-border',
                        (selectedVersion === v.version || (!selectedVersion && i === 0)) && 'bg-secondary'
                      )}
                    >
                      <div className="font-medium">{v.version}</div>
                      {v.message && (
                        <div className="text-[10px] text-muted-foreground">{v.message}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {formatDate(v.createdAt)}
                      </div>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )
        })()}
        {!editing && (
          <>
            {/* Download button for binary assets */}
            {isBinaryAsset(artifact) && (
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="shrink-0"
                title={`Download ${artifact.slug}`}
              >
                <a
                  href={`/boards/${encodeURIComponent(channel)}/${encodeURIComponent(artifact.slug)}`}
                  download={artifact.slug}
                >
                  <Download className="h-4 w-4" />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="shrink-0"
              title="Copy raw content"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            {!isBinaryAsset(artifact) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEdit}
                className="shrink-0"
                title="Edit content"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {artifact.status !== 'archived' && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    title="Archive"
                  >
                    <Archive className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive artifact?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will archive "{artifact.title || artifact.slug}". Archived artifacts can still be viewed but won't appear in the main list.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleArchive}>Archive</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </>
        )}
        {editing && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelEdit}
              className="shrink-0"
              title="Cancel"
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              className="shrink-0 gap-1"
              disabled={saving}
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </>
        )}
      </div>

      {/* Editor (full pane) */}
      {editing && (
        <div className="flex-1 flex flex-col min-h-0 p-3">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSave()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancelEdit()
              }
            }}
            className="flex-1 w-full font-mono text-sm bg-secondary/30 border border-border rounded p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Enter content..."
            autoFocus
          />
          <div className="text-[10px] text-muted-foreground text-center">
            <kbd className="px-1 py-0.5 bg-secondary rounded">⌘</kbd>+<kbd className="px-1 py-0.5 bg-secondary rounded">Enter</kbd> to save · <kbd className="px-1 py-0.5 bg-secondary rounded">Esc</kbd> to cancel
          </div>
        </div>
      )}

      {/* Content (read-only) */}
      {!editing && (
      <div className={cn(
        "flex-1 min-h-0",
        isSpaArtifact(artifact.slug) ? "flex flex-col" : "overflow-y-auto"
      )}>
        <div className={cn(
          "p-3",
          isSpaArtifact(artifact.slug) ? "flex-1 flex flex-col min-h-0 space-y-3" : "space-y-4"
        )}>
          {/* Metadata badges */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn(
              "gap-1 text-[10px]",
              isSpaArtifact(artifact.slug) && "border-green-500/50 text-green-500"
            )}>
              <Icon className="h-3 w-3" />
              {getArtifactTypeLabel(artifact)}
            </Badge>
            {selectedVersion ? (
              // Read-only when viewing historical version
              <Badge className={cn('gap-1 text-[10px]', STATUS_COLORS[artifact.status])}>
                {STATUS_LABELS[artifact.status] || artifact.status}
              </Badge>
            ) : (
              // Editable status dropdown
              <Popover>
                <PopoverTrigger asChild>
                  <button className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity',
                    STATUS_COLORS[artifact.status]
                  )}>
                    {STATUS_LABELS[artifact.status] || artifact.status}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-40 p-1">
                  {(Object.keys(STATUS_LABELS) as Status[]).map((status) => (
                    <button
                      key={status}
                      onClick={() => handleUpdateStatus(status)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 text-xs rounded hover:bg-secondary/50 flex items-center gap-2',
                        artifact.status === status && 'bg-secondary'
                      )}
                    >
                      <span className={cn('w-2 h-2 rounded-full', STATUS_COLORS[status].split(' ')[0])} />
                      {STATUS_LABELS[status]}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* TLDR */}
          {selectedVersion ? (
            // Read-only when viewing historical version
            <div className="bg-secondary/50 rounded p-3">
              <div className="text-[10px] font-medium text-muted-foreground mb-1 uppercase tracking-wider">Summary</div>
              <p className="text-sm">{displayTldr}</p>
            </div>
          ) : (
            // Editable when viewing current version
            <EditableField
              label="Summary"
              value={artifact.tldr || ''}
              onChange={handleUpdateTldr}
              placeholder="Click to add a summary..."
              multiline
              minHeight="min-h-[3rem]"
            />
          )}

          {/* Assignees for tasks */}
          {artifact.assignees && artifact.assignees.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Assigned to:</span>
              {artifact.assignees.map(a => (
                <Badge key={a} variant="secondary" className="text-[10px]">
                  @{a}
                </Badge>
              ))}
            </div>
          )}

          {/* Labels */}
          {artifact.labels && artifact.labels.length > 0 && (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <Tag className="h-3.5 w-3.5 text-muted-foreground" />
              {artifact.labels.map(l => (
                <Badge key={l} variant="outline" className="text-[10px]">
                  {l}
                </Badge>
              ))}
            </div>
          )}

          {/* Agent props for system.agent */}
          {artifact.type === 'system.agent' && !selectedVersion && (
            <div className="space-y-3">
              {/* Engine */}
              <EditableSelect
                label="Engine"
                value={(artifact.props as AgentProps)?.engine || 'claude'}
                onChange={(value) => handleUpdateProps({ engine: value })}
                options={backends.length > 0
                  ? backends.map(b => ({
                      value: b.name,
                      label: b.name.charAt(0).toUpperCase() + b.name.slice(1) + (b.isBuiltIn ? '' : ' (custom)')
                    }))
                  : [{ value: 'claude', label: 'Claude' }]
                }
              />

              {/* Name Theme */}
              <EditableSelect
                label="Call Sign Theme"
                value={(artifact.props as AgentProps)?.nameTheme || ''}
                onChange={(value) => handleUpdateProps({
                  nameTheme: value as NameTheme || undefined,
                  // Clear agentName when switching to a theme
                  ...(value ? { agentName: undefined } : {})
                })}
                options={[
                  { value: '', label: 'Singleton (fixed callsign)' },
                  ...(Object.keys(NAME_THEMES) as NameTheme[]).map(theme => ({
                    value: theme,
                    label: `${theme.charAt(0).toUpperCase() + theme.slice(1)} (${NAME_THEMES[theme].slice(0, 3).join(', ')}...)`
                  }))
                ]}
              />

              {/* Agent Name (only for singletons) */}
              {!(artifact.props as AgentProps)?.nameTheme && (
                <EditableField
                  label="Fixed Call Sign"
                  value={(artifact.props as AgentProps)?.agentName || ''}
                  onChange={(value) => handleUpdateProps({ agentName: value })}
                  placeholder="e.g., lead"
                />
              )}

              {/* MCP Servers assignment - only show if engine supports MCP */}
              {(() => {
                const engineName = (artifact.props as AgentProps)?.engine || 'claude'
                const engine = backends.find(b => b.name.toLowerCase() === engineName.toLowerCase())
                const supportsMcp = engine?.capabilities?.supportsMcp !== false
                return supportsMcp
              })() && (
              <div className="space-y-2 border-t pt-3 mt-3">
                <label className="text-xs font-medium text-muted-foreground uppercase">
                  MCP Servers
                </label>
                <div className="rounded-md border bg-secondary/30">
                  {/* Assigned MCPs */}
                  {((artifact.props as AgentProps)?.mcp?.length || 0) > 0 ? (
                    <div className="divide-y divide-border">
                      {(artifact.props as AgentProps)?.mcp?.map((mcpRef) => {
                        const mcpInfo = availableMcps.find(m => m.slug === mcpRef.slug)
                        return (
                          <div key={mcpRef.slug} className="flex items-start gap-2 px-3 py-2 group">
                            <Plug className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{mcpRef.slug}</div>
                              {mcpInfo?.tldr && (
                                <div className="text-xs text-muted-foreground truncate">{mcpInfo.tldr}</div>
                              )}
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 flex-shrink-0"
                              onClick={() => {
                                const currentMcps = (artifact.props as AgentProps)?.mcp || []
                                handleUpdateProps({
                                  mcp: currentMcps.filter(m => m.slug !== mcpRef.slug)
                                })
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm text-muted-foreground italic">
                      No MCP servers assigned
                    </div>
                  )}

                  {/* Add MCP dropdown */}
                  {(() => {
                    const assignedSlugs = new Set((artifact.props as AgentProps)?.mcp?.map(m => m.slug) || [])
                    const unassignedMcps = availableMcps.filter(m => !assignedSlugs.has(m.slug))

                    return (
                      <div className="border-t border-border">
                        {availableMcps.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            No MCP servers configured. Create one in the board first.
                          </div>
                        ) : unassignedMcps.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            All available MCPs are assigned
                          </div>
                        ) : (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 w-full transition-colors">
                                <Plus className="h-3.5 w-3.5" />
                                Add MCP server
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-64 p-0" align="start">
                              <div className="max-h-48 overflow-y-auto">
                                {unassignedMcps.map((mcp) => (
                                  <button
                                    key={mcp.slug}
                                    className="w-full text-left px-3 py-2 hover:bg-secondary/50 transition-colors"
                                    onClick={() => {
                                      const currentMcps = (artifact.props as AgentProps)?.mcp || []
                                      handleUpdateProps({
                                        mcp: [...currentMcps, { slug: mcp.slug }]
                                      })
                                    }}
                                  >
                                    <div className="text-sm font-medium">{mcp.slug}</div>
                                    {mcp.tldr && (
                                      <div className="text-xs text-muted-foreground truncate">{mcp.tldr}</div>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                      </div>
                    )
                  })()}
                </div>
              </div>
              )}
            </div>
          )}

          {/* MCP props for system.mcp */}
          {artifact.type === 'system.mcp' && !selectedVersion && (
            <div className="space-y-4">
              {/* Transport Type */}
              <SegmentedControl<McpTransport>
                label="Transport"
                value={(artifact.props as McpProps)?.transport || 'stdio'}
                onChange={(value) => handleUpdateMcpProps({ transport: value })}
                options={[
                  { value: 'stdio', label: 'stdio' },
                  { value: 'http', label: 'http' },
                ]}
              />

              {/* stdio transport fields */}
              {((artifact.props as McpProps)?.transport || 'stdio') === 'stdio' && (
                <div className="space-y-3">
                  {/* Command */}
                  <EditableField
                    label="Command"
                    value={(artifact.props as McpProps)?.command || ''}
                    onChange={(value) => handleUpdateMcpProps({ command: value })}
                    placeholder="e.g., npx"
                  />

                  {/* Arguments */}
                  <StringListEditor
                    label="Arguments"
                    items={(artifact.props as McpProps)?.args || []}
                    onChange={(items) => handleUpdateMcpProps({ args: items })}
                    placeholder="e.g., -y @modelcontextprotocol/server-github"
                  />

                  {/* Working Directory */}
                  <EditableField
                    label="Working Directory"
                    value={(artifact.props as McpProps)?.cwd || ''}
                    onChange={(value) => handleUpdateMcpProps({ cwd: value || undefined })}
                    placeholder="/path/to/working/dir"
                  />

                  {/* Environment Variables */}
                  <KeyValueEditor
                    label="Environment Variables"
                    entries={Object.entries((artifact.props as McpProps)?.env || {}).map(([key, value]) => ({ key, value }))}
                    onChange={(entries) => {
                      const env = entries.reduce((acc, { key, value }) => {
                        if (key) acc[key] = value
                        return acc
                      }, {} as Record<string, string>)
                      handleUpdateMcpProps({ env: Object.keys(env).length > 0 ? env : undefined })
                    }}
                    keyPlaceholder="VARIABLE_NAME"
                    valuePlaceholder="value or ${ENV_REF}"
                  />
                </div>
              )}

              {/* http transport fields */}
              {(artifact.props as McpProps)?.transport === 'http' && (
                <div className="space-y-3">
                  {/* URL */}
                  <EditableField
                    label="URL"
                    value={(artifact.props as McpProps)?.url || ''}
                    onChange={(value) => handleUpdateMcpProps({ url: value })}
                    placeholder="https://mcp.example.com/sse"
                  />

                  {/* Headers */}
                  <KeyValueEditor
                    label="Headers"
                    entries={Object.entries((artifact.props as McpProps)?.headers || {}).map(([key, value]) => ({ key, value }))}
                    onChange={(entries) => {
                      const headers = entries.reduce((acc, { key, value }) => {
                        if (key) acc[key] = value
                        return acc
                      }, {} as Record<string, string>)
                      handleUpdateMcpProps({ headers: Object.keys(headers).length > 0 ? headers : undefined })
                    }}
                    keyPlaceholder="Header-Name"
                    valuePlaceholder="value or ${ENV_REF}"
                  />

                  {/* Authentication */}
                  <SegmentedControl<McpAuthType>
                    label="Authentication"
                    value={(artifact.props as McpProps)?.auth?.type || 'none'}
                    onChange={(value) => {
                      if (value === 'none') {
                        handleUpdateMcpProps({ auth: undefined })
                      } else {
                        handleUpdateMcpProps({ auth: { type: value } })
                      }
                    }}
                    options={[
                      { value: 'none', label: 'None' },
                      { value: 'api_key', label: 'API Key' },
                      { value: 'oauth', label: 'OAuth 2.1' },
                    ]}
                  />

                  {/* API Key header (shown when API Key selected) */}
                  {(artifact.props as McpProps)?.auth?.type === 'api_key' && (
                    <EditableField
                      label="Authorization Header"
                      value={(artifact.props as McpProps)?.auth?.header || ''}
                      onChange={(value) => {
                        const currentAuth = (artifact.props as McpProps)?.auth || { type: 'api_key' as const }
                        handleUpdateMcpProps({ auth: { ...currentAuth, header: value || undefined } })
                      }}
                      placeholder="Bearer ${API_KEY}"
                    />
                  )}

                  {/* OAuth Connection (shown when OAuth selected) */}
                  {(artifact.props as McpProps)?.auth?.type === 'oauth' && (
                    <OAuthConnectButton
                      channel={channel}
                      mcpSlug={slug}
                      mcpTitle={artifact.title || slug}
                    />
                  )}
                </div>
              )}

              {/* Capabilities (shared between both transports) */}
              <EditableField
                label="Capabilities"
                value={(artifact.props as McpProps)?.capabilities || ''}
                onChange={(value) => handleUpdateMcpProps({ capabilities: value || undefined })}
                placeholder="Describe what this MCP server provides..."
                multiline
                minHeight="min-h-[4rem]"
              />
            </div>
          )}

          {/* Focus props for system.focus */}
          {artifact.type === 'system.focus' && !selectedVersion && (
            <div className="space-y-3">
              {/* Starting Agents multi-select */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase">
                  Starting Agents
                </label>
                <div className="flex flex-wrap gap-2">
                  {availableAgents.map(agent => {
                    const focusProps = artifact.props as FocusProps
                    const isSelected = focusProps?.agents?.includes(agent.slug)
                    return (
                      <button
                        key={agent.slug}
                        onClick={() => {
                          const currentAgents = focusProps?.agents || []
                          const newAgents = isSelected
                            ? currentAgents.filter(a => a !== agent.slug)
                            : [...currentAgents, agent.slug]
                          handleUpdateFocusProps({ agents: newAgents })
                        }}
                        className={cn(
                          'px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
                          isSelected
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary/50 text-muted-foreground border-border hover:border-primary/50'
                        )}
                      >
                        {agent.title}
                      </button>
                    )
                  })}
                </div>
                {availableAgents.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">No agent types found in #root</p>
                )}
              </div>

              {/* Default Tagline */}
              <EditableField
                label="Default Tagline"
                value={(artifact.props as FocusProps)?.defaultTagline || ''}
                onChange={(value) => handleUpdateFocusProps({ defaultTagline: value })}
                placeholder="e.g., A new Research project"
              />

              {/* Default Mission */}
              <EditableField
                label="Default Mission"
                value={(artifact.props as FocusProps)?.defaultMission || ''}
                onChange={(value) => handleUpdateFocusProps({ defaultMission: value })}
                placeholder="Describe the default mission for channels with this focus..."
                multiline
                minHeight="min-h-[80px]"
              />

              {/* Initial Prompt */}
              <EditableField
                label="Initial Prompt"
                value={(artifact.props as FocusProps)?.initialPrompt || ''}
                onChange={(value) => handleUpdateFocusProps({ initialPrompt: value })}
                placeholder="Casual prompt to guide the first agent's opening message..."
                multiline
                minHeight="min-h-[60px]"
              />
            </div>
          )}

          {/* Content */}
          <div className={cn(
            "border-t pt-4",
            (isSpaArtifact(artifact.slug) || isBinaryAsset(artifact)) && "flex-1 flex flex-col min-h-0"
          )}>
            {isBinaryAsset(artifact) ? (
              <BinaryAssetPreview
                channel={channel}
                slug={artifact.slug}
                contentType={artifact.contentType}
              />
            ) : artifact.type === 'code' && isSpaArtifact(artifact.slug) ? (
              <SpaRenderer
                content={displayContent}
                channel={channel}
                slug={slug}
              />
            ) : artifact.type === 'code' ? (
              <SyntaxHighlighter
                language={getLanguageFromSlug(artifact.slug)}
                style={oneDark}
                customStyle={{
                  margin: 0,
                  borderRadius: '0.375rem',
                  fontSize: '0.75rem',
                }}
                showLineNumbers
              >
                {displayContent}
              </SyntaxHighlighter>
            ) : (
              <ReactMarkdown
                className="prose prose-invert prose-sm max-w-none"
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p className="mb-2 last:mb-0">{processChildren(children)}</p>,
                  h1: ({ children }) => <h1 className="text-xl font-semibold mt-4 mb-2">{processChildren(children)}</h1>,
                  h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{processChildren(children)}</h2>,
                  h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1">{processChildren(children)}</h3>,
                  code: ({ children, className }) => {
                    const isBlock = className?.includes('language-')
                    return isBlock ? (
                      <code className={className}>{children}</code>
                    ) : (
                      <code className="bg-secondary rounded px-1 py-0.5 text-xs">{children}</code>
                    )
                  },
                  pre: ({ children }) => (
                    <pre className="bg-secondary rounded p-2 overflow-x-auto text-xs my-2 whitespace-pre-wrap">
                      {children}
                    </pre>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-2">
                      <table className="min-w-full text-sm border border-border">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th className="px-2 py-1 bg-secondary border border-border text-left font-medium">{processChildren(children)}</th>,
                  td: ({ children }) => <td className="px-2 py-1 border border-border">{processChildren(children)}</td>,
                  ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="pl-1">{processChildren(children)}</li>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic">
                      {processChildren(children)}
                    </blockquote>
                  ),
                  hr: () => <hr className="border-border my-4" />,
                }}
              >
                {displayContent}
              </ReactMarkdown>
            )}
          </div>

          {/* Metadata footer - hidden for SPA and binary artifacts */}
          {!isSpaArtifact(artifact.slug) && !isBinaryAsset(artifact) && (
          <div className="border-t pt-4 space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <User className="h-3.5 w-3.5" />
              <span>Created by {artifact.createdBy} &middot; {formatDate(artifact.createdAt)}</span>
            </div>
            {artifact.updatedBy && (
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" />
                <span>Updated by {artifact.updatedBy} &middot; {formatDate(artifact.updatedAt!)}</span>
              </div>
            )}
          </div>
          )}

          {/* Version history - hidden for SPA and binary artifacts */}
          {!isSpaArtifact(artifact.slug) && !isBinaryAsset(artifact) && versions.length > 0 && (
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Versions ({versions.length})
                </span>
              </div>
              <div className="space-y-1">
                {versions.map(v => (
                  <div
                    key={v.version}
                    className="p-2 rounded bg-secondary/30 text-xs"
                  >
                    <div className="font-medium">{v.version}</div>
                    {v.message && (
                      <div className="text-muted-foreground mt-0.5">{v.message}</div>
                    )}
                    <div className="text-muted-foreground mt-1">
                      {v.createdBy} &middot; {formatDate(v.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* References - hidden for SPA and binary artifacts */}
          {!isSpaArtifact(artifact.slug) && !isBinaryAsset(artifact) && artifact.refs && artifact.refs.length > 0 && (
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  References
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {artifact.refs.map(r => (
                  <button
                    key={r}
                    onClick={() => onNavigate(r)}
                    className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border border-input bg-background hover:bg-secondary hover:text-primary transition-colors"
                  >
                    [[{r}]]
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
