/**
 * AttachmentRenderer - Unified attachment preview with plugin/handler pattern
 *
 * Renders file attachments with appropriate previews based on MIME type.
 * Uses authenticated fetch + blob URLs to handle auth cookies properly.
 * Extensible architecture allows adding new handlers without changes to core component.
 */

import { useState, useEffect } from 'react'
import { Download, ExternalLink, FileText, Image, FileCode, File, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Attachment } from '../../types'

// =============================================================================
// Handler Interface
// =============================================================================

/**
 * Handler interface for attachment rendering.
 * Implement this to add support for new file types.
 */
export interface AttachmentHandler {
  /** Unique handler identifier */
  id: string
  /** Check if this handler can render the attachment */
  canHandle: (attachment: Attachment) => boolean
  /** Render the attachment preview (receives blob URL, not original URL) */
  render: (props: AttachmentRenderProps) => React.ReactNode
  /** Icon component for this file type */
  icon: React.ComponentType<{ className?: string }>
  /** Priority (higher = checked first) */
  priority: number
}

export interface AttachmentRenderProps {
  attachment: Attachment
  /** Blob URL for authenticated access to the attachment */
  blobUrl: string
  /** Whether to show compact view (for inline in messages) */
  compact?: boolean
}

// =============================================================================
// Built-in Handlers
// =============================================================================

/**
 * Image handler - inline preview for images
 */
const imageHandler: AttachmentHandler = {
  id: 'image',
  priority: 100,
  icon: Image,
  canHandle: (attachment) => attachment.mimeType.startsWith('image/'),
  render: ({ attachment, blobUrl, compact }) => (
    <div className={cn("space-y-2", compact && "max-w-xs")}>
      <img
        src={blobUrl}
        alt={attachment.filename}
        className={cn(
          "border border-[var(--cast-border-default)]",
          compact ? "max-h-48 max-w-full" : "max-w-full"
        )}
      />
      {!compact && (
        <AttachmentActions blobUrl={blobUrl} filename={attachment.filename} />
      )}
    </div>
  ),
}

/**
 * PDF handler - embed or link to PDF documents
 */
const pdfHandler: AttachmentHandler = {
  id: 'pdf',
  priority: 90,
  icon: FileText,
  canHandle: (attachment) => attachment.mimeType === 'application/pdf',
  render: ({ attachment, blobUrl, compact }) => (
    <div className="space-y-2">
      {compact ? (
        <AttachmentCard
          attachment={attachment}
          blobUrl={blobUrl}
          icon={FileText}
        />
      ) : (
        <>
          <iframe
            src={blobUrl}
            title={attachment.filename}
            className="w-full h-80 border border-[var(--cast-border-default)]"
          />
          <AttachmentActions blobUrl={blobUrl} filename={attachment.filename} />
        </>
      )}
    </div>
  ),
}

/**
 * Code handler - syntax highlighted preview (stub for now)
 * TODO: Implement syntax highlighting with highlight.js or similar
 */
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.css', '.scss', '.html', '.xml', '.sh', '.bash', '.sql'
]

const CODE_MIME_TYPES = [
  'text/plain',
  'text/javascript',
  'text/typescript',
  'application/json',
  'text/markdown',
  'text/yaml',
  'text/x-python',
  'text/x-ruby',
]

const codeHandler: AttachmentHandler = {
  id: 'code',
  priority: 80,
  icon: FileCode,
  canHandle: (attachment) => {
    // Check MIME type
    if (CODE_MIME_TYPES.some(mime => attachment.mimeType.startsWith(mime))) {
      return true
    }
    // Check file extension
    const filename = attachment.filename.toLowerCase()
    return CODE_EXTENSIONS.some(ext => filename.endsWith(ext))
  },
  render: ({ attachment, blobUrl }) => (
    <AttachmentCard
      attachment={attachment}
      blobUrl={blobUrl}
      icon={FileCode}
      subtitle="Code file"
    />
    // TODO: Fetch content and render with syntax highlighting
    // For now, just show a download card
  ),
}

/**
 * Fallback handler - generic file with download link
 */
const fallbackHandler: AttachmentHandler = {
  id: 'fallback',
  priority: 0,
  icon: File,
  canHandle: () => true, // Always matches as last resort
  render: ({ attachment, blobUrl }) => (
    <AttachmentCard
      attachment={attachment}
      blobUrl={blobUrl}
      icon={File}
    />
  ),
}

// =============================================================================
// Handler Registry
// =============================================================================

/**
 * Registry of all attachment handlers, sorted by priority (descending)
 */
const handlers: AttachmentHandler[] = [
  imageHandler,
  pdfHandler,
  codeHandler,
  fallbackHandler,
].sort((a, b) => b.priority - a.priority)

/**
 * Find the appropriate handler for an attachment
 */
function getHandler(attachment: Attachment): AttachmentHandler {
  return handlers.find(h => h.canHandle(attachment)) || fallbackHandler
}

// =============================================================================
// Shared Components
// =============================================================================

interface AttachmentActionsProps {
  blobUrl: string
  filename: string
}

/**
 * Open and download buttons for attachments
 */
function AttachmentActions({ blobUrl, filename }: AttachmentActionsProps) {
  return (
    <div className="flex gap-2">
      <a
        href={blobUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 px-2 py-1 text-xs hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] border border-[var(--cast-border-default)] transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        Open
      </a>
      <a
        href={blobUrl}
        download={filename}
        className="flex items-center gap-1 px-2 py-1 text-xs hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] border border-[var(--cast-border-default)] transition-colors"
      >
        <Download className="w-3 h-3" />
        Download
      </a>
    </div>
  )
}

interface AttachmentCardProps {
  attachment: Attachment
  blobUrl: string
  icon: React.ComponentType<{ className?: string }>
  subtitle?: string
}

/**
 * Compact card view for non-previewable attachments
 */
function AttachmentCard({ attachment, blobUrl, icon: Icon, subtitle }: AttachmentCardProps) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] hover:border-[#ccc] transition-colors">
      <Icon className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">{attachment.filename}</div>
        <div className="text-xs text-[var(--cast-text-muted)]">
          {subtitle || formatFileSize(attachment.size)}
        </div>
      </div>
      <div className="flex gap-1">
        <a
          href={blobUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] transition-colors"
          title="Open"
        >
          <ExternalLink className="w-4 h-4" />
        </a>
        <a
          href={blobUrl}
          download={attachment.filename}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] transition-colors"
          title="Download"
        >
          <Download className="w-4 h-4" />
        </a>
      </div>
    </div>
  )
}

/**
 * Loading state while fetching attachment
 */
function AttachmentLoading({ attachment }: { attachment: Attachment }) {
  const handler = getHandler(attachment)
  const Icon = handler.icon

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] animate-pulse">
      <Icon className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">{attachment.filename}</div>
        <div className="text-xs text-[var(--cast-text-muted)] flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading...
        </div>
      </div>
    </div>
  )
}

/**
 * Error state when attachment fetch fails
 */
function AttachmentError({ attachment, error }: { attachment: Attachment; error: string }) {
  const handler = getHandler(attachment)
  const Icon = handler.icon

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-destructive/10 border border-destructive/30">
      <Icon className="w-5 h-5 text-destructive flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate">{attachment.filename}</div>
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
      </div>
    </div>
  )
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

// =============================================================================
// Blob URL Hook
// =============================================================================

type FetchState =
  | { status: 'loading' }
  | { status: 'success'; blobUrl: string }
  | { status: 'error'; error: string }

/**
 * Hook to fetch attachment with credentials and create blob URL
 */
function useAuthenticatedBlobUrl(url: string): FetchState {
  const [state, setState] = useState<FetchState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let blobUrl: string | null = null

    async function fetchBlob() {
      try {
        const response = await fetch(url, {
          credentials: 'include',
        })

        if (response.status === 401) {
          // Session expired - auth will be handled by WorkOS later
          throw new Error('Authentication required')
        }

        if (!response.ok) {
          throw new Error(`Failed to load (${response.status})`)
        }

        const blob = await response.blob()

        if (cancelled) return

        blobUrl = URL.createObjectURL(blob)
        setState({ status: 'success', blobUrl })
      } catch (err) {
        if (cancelled) return
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to load attachment'
        })
      }
    }

    setState({ status: 'loading' })
    fetchBlob()

    return () => {
      cancelled = true
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [url])

  return state
}

// =============================================================================
// Main Component
// =============================================================================

interface AttachmentRendererProps {
  attachment: Attachment
  /** API host for constructing URLs */
  apiHost: string
  /** Whether to show compact view */
  compact?: boolean
  className?: string
}

/**
 * Renders an attachment with appropriate preview based on file type.
 * Uses authenticated fetch + blob URLs to handle auth properly.
 */
export function AttachmentRenderer({
  attachment,
  apiHost,
  compact = false,
  className,
}: AttachmentRendererProps) {
  const handler = getHandler(attachment)
  const url = attachment.url.startsWith('http')
    ? attachment.url
    : `${apiHost}${attachment.url}`

  const fetchState = useAuthenticatedBlobUrl(url)

  return (
    <div className={cn("attachment-renderer", className)}>
      {fetchState.status === 'loading' && (
        <AttachmentLoading attachment={attachment} />
      )}
      {fetchState.status === 'error' && (
        <AttachmentError attachment={attachment} error={fetchState.error} />
      )}
      {fetchState.status === 'success' && (
        handler.render({ attachment, blobUrl: fetchState.blobUrl, compact })
      )}
    </div>
  )
}

/**
 * Renders multiple attachments in a grid/list layout
 */
interface AttachmentListProps {
  attachments: Attachment[]
  apiHost: string
  compact?: boolean
  className?: string
}

export function AttachmentList({
  attachments,
  apiHost,
  compact = false,
  className,
}: AttachmentListProps) {
  if (!attachments || attachments.length === 0) return null

  return (
    <div className={cn(
      "attachment-list",
      compact ? "flex flex-wrap gap-2" : "space-y-3",
      className
    )}>
      {attachments.map((attachment) => (
        <AttachmentRenderer
          key={attachment.id}
          attachment={attachment}
          apiHost={apiHost}
          compact={compact}
        />
      ))}
    </div>
  )
}

// =============================================================================
// Exports
// =============================================================================

export { getHandler, handlers, formatFileSize }
// Types are already exported at definition
