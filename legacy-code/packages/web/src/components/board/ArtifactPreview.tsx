import { useState } from 'react'
import { Pencil, Download, ExternalLink } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Artifact } from '../../types/artifact'
import { McpPropsEditor, McpProps } from './McpPropsEditor'

interface ArtifactPreviewProps {
  artifact: Artifact
  onEdit: () => void
  onLinkClick: (slug: string) => void
  /** API host for asset URLs */
  apiHost?: string
  /** Channel ID for asset URLs */
  channelId?: string
  /** Callback when props are updated (for system.* artifacts) */
  onPropsUpdate?: (props: Record<string, unknown>) => Promise<void>
}

// File extensions that are treated as viewable assets
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']
const PDF_EXTENSION = '.pdf'

/**
 * Check if an artifact slug represents an asset (image or PDF)
 */
function isAssetSlug(slug: string | undefined): { isAsset: boolean; isImage: boolean; isPdf: boolean } {
  if (!slug) return { isAsset: false, isImage: false, isPdf: false }
  const lower = slug.toLowerCase()
  const isImage = IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
  const isPdf = lower.endsWith(PDF_EXTENSION)
  return { isAsset: isImage || isPdf, isImage, isPdf }
}

// Status colors for the badge
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-200 text-gray-700',
  published: 'bg-green-200 text-green-700',
  archived: 'bg-gray-200 text-gray-500',
  pending: 'bg-gray-200 text-gray-700',
  in_progress: 'bg-blue-200 text-blue-700',
  done: 'bg-green-200 text-green-700',
  blocked: 'bg-red-200 text-red-700',
}

export function ArtifactPreview({ artifact, onEdit, onLinkClick, apiHost, channelId, onPropsUpdate }: ArtifactPreviewProps) {
  const { isAsset, isImage, isPdf } = isAssetSlug(artifact.slug)
  const assetUrl = apiHost && channelId ? `${apiHost}/channels/${channelId}/assets/${artifact.slug}` : null
  const [saving, setSaving] = useState(false)

  // Handle MCP props updates
  const handleMcpPropsChange = async (updates: Partial<McpProps>) => {
    if (!onPropsUpdate) return

    setSaving(true)
    try {
      const currentProps = (artifact.props as unknown as McpProps) || { transport: 'stdio' as const }
      const newProps = { ...currentProps, ...updates }
      await onPropsUpdate(newProps as unknown as Record<string, unknown>)
    } catch (e) {
      console.error('Failed to update MCP props:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-3 py-2 border-b border-border">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm text-foreground truncate">
            {artifact.title || artifact.slug}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground">
              {artifact.type}
            </span>
            <span className={cn(
              "text-xs px-1.5 py-0.5 rounded",
              STATUS_COLORS[artifact.status] || STATUS_COLORS.draft
            )}>
              {artifact.status}
            </span>
          </div>
        </div>
        <button
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground"
          onClick={onEdit}
        >
          <Pencil className="w-3 h-3" />
          Edit
        </button>
      </div>

      {/* TLDR */}
      <div className="px-3 py-2 border-b border-border bg-secondary/20">
        <p className="text-sm text-muted-foreground">{artifact.tldr}</p>
      </div>

      {/* MCP Props Editor - shown for system.mcp artifacts */}
      {artifact.type === 'system.mcp' && onPropsUpdate && (
        <div className="px-3 py-3 border-b border-border">
          {saving && (
            <div className="text-xs text-muted-foreground mb-2">Saving...</div>
          )}
          <McpPropsEditor
            props={(artifact.props as unknown as McpProps) || { transport: 'stdio' as const }}
            onChange={handleMcpPropsChange}
          />
        </div>
      )}

      {/* Content - check if this is an asset with preview */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isAsset && assetUrl ? (
          <AssetPreview
            slug={artifact.slug}
            url={assetUrl}
            isImage={isImage}
            isPdf={isPdf}
          />
        ) : (
          <ArtifactContent content={artifact.content} onLinkClick={onLinkClick} />
        )}
      </div>

      {/* Metadata footer */}
      {((artifact.assignees?.length ?? 0) > 0 || (artifact.labels?.length ?? 0) > 0) && (
        <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
          {(artifact.assignees?.length ?? 0) > 0 && (
            <div>Assignees: {artifact.assignees?.join(', ')}</div>
          )}
          {(artifact.labels?.length ?? 0) > 0 && (
            <div>Labels: {artifact.labels?.join(', ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

interface ArtifactContentProps {
  content: string
  onLinkClick: (slug: string) => void
}

/**
 * Render artifact content with [[slug]] links made clickable.
 * For now, uses simple text rendering with link parsing.
 * Could be enhanced with full markdown support later.
 */
function ArtifactContent({ content, onLinkClick }: ArtifactContentProps) {
  // Parse content and replace [[slug]] with clickable links
  const parts = parseContentWithLinks(content)

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {parts.map((part, index) => {
        if (part.type === 'link') {
          return (
            <button
              key={index}
              className="text-primary hover:underline font-medium bg-transparent border-none cursor-pointer"
              onClick={() => onLinkClick(part.slug!)}
            >
              [[{part.slug}]]
            </button>
          )
        }
        // Render text with basic whitespace preservation
        return (
          <span key={index} className="whitespace-pre-wrap">
            {part.text}
          </span>
        )
      })}
    </div>
  )
}

interface ContentPart {
  type: 'text' | 'link'
  text?: string
  slug?: string
}

/**
 * Parse content string and extract [[slug]] references.
 */
function parseContentWithLinks(content: string): ContentPart[] {
  const parts: ContentPart[] = []
  const regex = /\[\[([a-z0-9-]+(?:\.[a-z0-9]+)*)\]\]/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(content)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        text: content.slice(lastIndex, match.index),
      })
    }

    // Add the link
    parts.push({
      type: 'link',
      slug: match[1],
    })

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push({
      type: 'text',
      text: content.slice(lastIndex),
    })
  }

  return parts
}

interface AssetPreviewProps {
  slug: string
  url: string
  isImage: boolean
  isPdf: boolean
}

/**
 * Preview component for binary assets (images and PDFs).
 */
function AssetPreview({ slug, url, isImage, isPdf }: AssetPreviewProps) {
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

  return null
}
