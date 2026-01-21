/**
 * AssetPreview - Shared component for rendering asset previews
 *
 * Used by both the board (ArtifactDetail) and messages (AttachmentRenderer).
 * Uses MIME-type based detection for proper file type handling.
 */

import { Download, ExternalLink } from 'lucide-react'
import { cn } from '../../lib/utils'

// =============================================================================
// MIME-type detection
// =============================================================================

export function isImageMime(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith('image/') ?? false
}

export function isPdfMime(mimeType: string | null | undefined): boolean {
  return mimeType === 'application/pdf'
}

export function isAudioMime(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith('audio/') ?? false
}

export function isVideoMime(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith('video/') ?? false
}

export function isPreviewableMime(mimeType: string | null | undefined): boolean {
  return (
    isImageMime(mimeType) ||
    isPdfMime(mimeType) ||
    isAudioMime(mimeType) ||
    isVideoMime(mimeType)
  )
}

// =============================================================================
// Types
// =============================================================================

export interface AssetPreviewProps {
  /** URL to the asset (can be blob URL or direct URL) */
  url: string
  /** Filename for download */
  filename: string
  /** MIME type of the asset */
  contentType: string | null | undefined
  /** Alt text for images */
  alt?: string
  /** Compact mode for inline display */
  compact?: boolean
  /** Additional class names */
  className?: string
}

// =============================================================================
// Shared sub-components
// =============================================================================

interface AssetActionsProps {
  url: string
  filename: string
  openLabel?: string
}

function AssetActions({ url, filename, openLabel = 'Open' }: AssetActionsProps) {
  return (
    <div className="flex gap-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
      >
        <ExternalLink className="w-3 h-3" />
        {openLabel}
      </a>
      <a
        href={url}
        download={filename}
        className="flex items-center gap-1 px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
      >
        <Download className="w-3 h-3" />
        Download
      </a>
    </div>
  )
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Renders an asset preview based on its MIME type.
 * Supports images, PDFs, audio, and video.
 */
export function AssetPreview({
  url,
  filename,
  contentType,
  alt,
  compact = false,
  className,
}: AssetPreviewProps) {
  const displayAlt = alt || filename

  // Image preview
  if (isImageMime(contentType)) {
    return (
      <div className={cn('space-y-3', compact && 'max-w-xs', className)}>
        <img
          src={url}
          alt={displayAlt}
          className={cn(
            'border border-border rounded',
            compact ? 'max-h-48 max-w-full' : 'max-w-full'
          )}
          loading="lazy"
        />
        {!compact && <AssetActions url={url} filename={filename} />}
      </div>
    )
  }

  // PDF preview
  if (isPdfMime(contentType)) {
    if (compact) {
      // Compact mode - just show actions, no embed
      return null
    }
    return (
      <div className={cn('space-y-3', className)}>
        <AssetActions url={url} filename={filename} openLabel="Open PDF" />
        <iframe
          src={url}
          title={displayAlt}
          className="w-full h-80 border border-border rounded"
        />
      </div>
    )
  }

  // Audio preview
  if (isAudioMime(contentType)) {
    if (compact) {
      return null
    }
    return (
      <div className={cn('space-y-3', className)}>
        <audio src={url} controls className="w-full" preload="metadata">
          Your browser does not support the audio element.
        </audio>
        <div className="flex gap-2">
          <a
            href={url}
            download={filename}
            className="flex items-center gap-1 px-2 py-1 text-base rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground border border-border"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
      </div>
    )
  }

  // Video preview
  if (isVideoMime(contentType)) {
    if (compact) {
      return null
    }
    return (
      <div className={cn('space-y-3', className)}>
        <video
          src={url}
          controls
          className="w-full max-h-96 rounded border border-border"
          preload="metadata"
        >
          Your browser does not support the video element.
        </video>
        <AssetActions url={url} filename={filename} />
      </div>
    )
  }

  // Unknown type - no preview available
  return null
}
