/**
 * MessageAttachments - Renders asset artifacts attached to messages
 *
 * Uses extension-based detection (same as board) to determine preview type.
 * Assets are fetched with credentials via blob URLs.
 */

import { useState, useEffect } from 'react'
import { Download, ExternalLink, FileText, Image, File, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

// =============================================================================
// Extension-based type detection (matches board/ArtifactDetail.tsx)
// =============================================================================

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']
const PDF_EXTENSION = '.pdf'

function getAssetType(slug: string): { isImage: boolean; isPdf: boolean } {
  const lower = slug.toLowerCase()
  const isImage = IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
  const isPdf = lower.endsWith(PDF_EXTENSION)
  return { isImage, isPdf }
}

function getIcon(slug: string) {
  const { isImage, isPdf } = getAssetType(slug)
  if (isImage) return Image
  if (isPdf) return FileText
  return File
}

// =============================================================================
// Blob URL Hook (authenticated fetch)
// =============================================================================

type FetchState =
  | { status: 'loading' }
  | { status: 'success'; blobUrl: string }
  | { status: 'error'; error: string }

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
          error: err instanceof Error ? err.message : 'Failed to load'
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
// Shared Components
// =============================================================================

function AssetActions({ blobUrl, slug }: { blobUrl: string; slug: string }) {
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
        download={slug}
        className="flex items-center gap-1 px-2 py-1 text-xs hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] border border-[var(--cast-border-default)] transition-colors"
      >
        <Download className="w-3 h-3" />
        Download
      </a>
    </div>
  )
}

function AssetCard({ slug, blobUrl }: { slug: string; blobUrl: string }) {
  const Icon = getIcon(slug)
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] hover:border-[#ccc] transition-colors">
      <Icon className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">{slug}</div>
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
          download={slug}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] transition-colors"
          title="Download"
        >
          <Download className="w-4 h-4" />
        </a>
      </div>
    </div>
  )
}

function AssetLoading({ slug }: { slug: string }) {
  const Icon = getIcon(slug)
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] animate-pulse">
      <Icon className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">{slug}</div>
        <div className="text-xs text-[var(--cast-text-muted)] flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading...
        </div>
      </div>
    </div>
  )
}

function AssetError({ slug, error }: { slug: string; error: string }) {
  const Icon = getIcon(slug)
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-destructive/10 border border-destructive/30">
      <Icon className="w-5 h-5 text-destructive flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate">{slug}</div>
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Main Components
// =============================================================================

interface AssetRendererProps {
  slug: string
  channelId: string
  apiHost: string
  compact?: boolean
  className?: string
}

/**
 * Renders a single asset attachment by slug.
 */
export function AssetRenderer({
  slug,
  channelId,
  apiHost,
  compact = false,
  className,
}: AssetRendererProps) {
  const url = `${apiHost}/api/channels/${channelId}/assets/${slug}`
  const fetchState = useAuthenticatedBlobUrl(url)
  const { isImage, isPdf } = getAssetType(slug)

  if (fetchState.status === 'loading') {
    return <AssetLoading slug={slug} />
  }

  if (fetchState.status === 'error') {
    return <AssetError slug={slug} error={fetchState.error} />
  }

  const { blobUrl } = fetchState

  // Image preview
  if (isImage) {
    return (
      <div className={cn("space-y-2", compact && "max-w-xs", className)}>
        <img
          src={blobUrl}
          alt={slug}
          className={cn(
            "border border-[var(--cast-border-default)]",
            compact ? "max-h-48 max-w-full" : "max-w-full"
          )}
        />
        {!compact && <AssetActions blobUrl={blobUrl} slug={slug} />}
      </div>
    )
  }

  // PDF preview
  if (isPdf && !compact) {
    return (
      <div className={cn("space-y-2", className)}>
        <iframe
          src={blobUrl}
          title={slug}
          className="w-full h-80 border border-[var(--cast-border-default)]"
        />
        <AssetActions blobUrl={blobUrl} slug={slug} />
      </div>
    )
  }

  // Card view (compact or non-previewable)
  return <AssetCard slug={slug} blobUrl={blobUrl} />
}

interface MessageAttachmentsProps {
  slugs: string[]
  channelId: string
  apiHost: string
  compact?: boolean
  className?: string
}

/**
 * Renders multiple asset attachments for a message.
 */
export function MessageAttachments({
  slugs,
  channelId,
  apiHost,
  compact = false,
  className,
}: MessageAttachmentsProps) {
  if (!slugs || slugs.length === 0) return null

  return (
    <div className={cn(
      compact ? "flex flex-wrap gap-2" : "space-y-3",
      className
    )}>
      {slugs.map((slug) => (
        <AssetRenderer
          key={slug}
          slug={slug}
          channelId={channelId}
          apiHost={apiHost}
          compact={compact}
        />
      ))}
    </div>
  )
}
