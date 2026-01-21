/**
 * AssetPreview - Shared component for rendering asset previews
 *
 * Used by both the board (ArtifactDetail) and messages (AttachmentRenderer).
 * Uses MIME-type based detection for proper file type handling.
 */

import { useState } from 'react'
import { Download, ExternalLink, MoreVertical } from 'lucide-react'
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

/**
 * Compact kebab menu for hover actions on previews.
 */
function CompactKebabMenu({ url, filename }: { url: string; filename: string }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 rounded bg-black/50 hover:bg-black/70 text-white transition-colors"
        title="More actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {isOpen && (
        <>
          {/* Backdrop to close menu */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          {/* Menu */}
          <div className="absolute left-full top-0 ml-1 z-20 bg-popover border border-[var(--cast-border-default)] rounded shadow-lg min-w-[120px]">
            <a
              href={url}
              download={filename}
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--cast-bg-hover)] text-[var(--cast-text-primary)] transition-colors"
            >
              <Download className="w-4 h-4" />
              Download
            </a>
          </div>
        </>
      )}
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
    if (compact) {
      return (
        <div className={cn('relative group max-w-xs', className)}>
          <img
            src={url}
            alt={displayAlt}
            className="max-h-48 max-w-full border border-border rounded"
            loading="lazy"
          />
          {/* Kebab menu - visible on hover */}
          <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <CompactKebabMenu url={url} filename={filename} />
          </div>
        </div>
      )
    }
    return (
      <div className={cn('space-y-3', className)}>
        <img
          src={url}
          alt={displayAlt}
          className="max-w-full border border-border rounded"
          loading="lazy"
        />
        <AssetActions url={url} filename={filename} />
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
