/**
 * MessageAttachments - Renders asset artifacts attached to messages
 *
 * Fetches artifact metadata to get contentType (MIME type) for proper rendering.
 * Uses shared AssetPreview component for actual rendering.
 */

import { useState, useEffect } from 'react'
import {
  Download,
  ExternalLink,
  FileText,
  Image,
  FileCode,
  File,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import {
  AssetPreview,
  isImageMime,
  isPdfMime,
  isPreviewableMime,
} from '../ui/asset-preview'
import type { Artifact } from '../../types'

// =============================================================================
// Types
// =============================================================================

interface AssetMetadata {
  slug: string
  contentType: string | null
  title?: string
  tldr?: string
}

type MetadataState =
  | { status: 'loading' }
  | { status: 'success'; metadata: AssetMetadata }
  | { status: 'error'; error: string }

type BlobState =
  | { status: 'loading' }
  | { status: 'success'; blobUrl: string }
  | { status: 'error'; error: string }

// =============================================================================
// MIME-type icon selection
// =============================================================================

function isCodeMime(mimeType: string | null): boolean {
  if (!mimeType) return false
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml'
  )
}

function getIconForMime(mimeType: string | null) {
  if (isImageMime(mimeType)) return Image
  if (isPdfMime(mimeType)) return FileText
  if (isCodeMime(mimeType)) return FileCode
  return File
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Fetch artifact metadata to get contentType and other info.
 */
function useAssetMetadata(
  slug: string,
  channelId: string,
  apiHost: string
): MetadataState {
  const [state, setState] = useState<MetadataState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function fetchMetadata() {
      try {
        const response = await apiFetch(
          `${apiHost}/channels/${channelId}/artifacts/${slug}`
        )

        if (!response.ok) {
          throw new Error(`Failed to load metadata (${response.status})`)
        }

        const artifact: Artifact = await response.json()

        if (cancelled) return

        setState({
          status: 'success',
          metadata: {
            slug: artifact.slug,
            contentType: artifact.contentType ?? null,
            title: artifact.title,
            tldr: artifact.tldr,
          },
        })
      } catch (err) {
        if (cancelled) return
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to load metadata',
        })
      }
    }

    setState({ status: 'loading' })
    fetchMetadata()

    return () => {
      cancelled = true
    }
  }, [slug, channelId, apiHost])

  return state
}

/**
 * Fetch asset binary with credentials and create blob URL.
 */
function useAuthenticatedBlobUrl(url: string): BlobState {
  const [state, setState] = useState<BlobState>({ status: 'loading' })

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
          error: err instanceof Error ? err.message : 'Failed to load',
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
// Loading/Error/Card Components
// =============================================================================

function AssetLoading({ slug }: { slug: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] animate-pulse">
      <File className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">
          {slug}
        </div>
        <div className="text-xs text-[var(--cast-text-muted)] flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading...
        </div>
      </div>
    </div>
  )
}

function AssetError({ slug, error }: { slug: string; error: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-destructive/10 border border-destructive/30">
      <File className="w-5 h-5 text-destructive flex-shrink-0" />
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

interface AssetCardProps {
  metadata: AssetMetadata
  blobUrl: string
}

/**
 * Card view for non-previewable assets or compact mode fallback.
 */
function AssetCard({ metadata, blobUrl }: AssetCardProps) {
  const Icon = getIconForMime(metadata.contentType)
  const displayName = metadata.title || metadata.slug

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 bg-[#fafafa] dark:bg-[var(--cast-bg-active)] border border-[var(--cast-border-default)] hover:border-[#ccc] transition-colors">
      <Icon className="w-5 h-5 text-[var(--cast-text-secondary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate text-[var(--cast-text-primary)]">
          {displayName}
        </div>
        {metadata.tldr && (
          <div className="text-xs text-[var(--cast-text-muted)] truncate">
            {metadata.tldr}
          </div>
        )}
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
          download={metadata.slug}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-muted)] hover:text-[var(--cast-text-primary)] transition-colors"
          title="Download"
        >
          <Download className="w-4 h-4" />
        </a>
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
 * Fetches metadata first to determine content type, then loads the binary.
 */
export function AssetRenderer({
  slug,
  channelId,
  apiHost,
  compact = false,
  className,
}: AssetRendererProps) {
  const metadataState = useAssetMetadata(slug, channelId, apiHost)
  const assetUrl = `${apiHost}/channels/${channelId}/assets/${slug}`
  const blobState = useAuthenticatedBlobUrl(assetUrl)

  // Show loading if either metadata or blob is loading
  if (metadataState.status === 'loading' || blobState.status === 'loading') {
    return <AssetLoading slug={slug} />
  }

  // Show error if either failed
  if (metadataState.status === 'error') {
    return <AssetError slug={slug} error={metadataState.error} />
  }
  if (blobState.status === 'error') {
    return <AssetError slug={slug} error={blobState.error} />
  }

  const { metadata } = metadataState
  const { blobUrl } = blobState
  const displayName = metadata.title || metadata.slug

  // Try to render with shared AssetPreview for previewable types
  if (isPreviewableMime(metadata.contentType)) {
    const preview = (
      <AssetPreview
        url={blobUrl}
        filename={metadata.slug}
        contentType={metadata.contentType}
        alt={displayName}
        compact={compact}
        className={className}
      />
    )

    // AssetPreview returns null for compact mode on non-image types
    // Fall back to card view in that case
    if (preview) {
      return preview
    }
  }

  // Card view for non-previewable types or when preview returns null
  return <AssetCard metadata={metadata} blobUrl={blobUrl} />
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
    <div
      className={cn(
        compact ? 'flex flex-wrap gap-2' : 'space-y-3',
        className
      )}
    >
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
