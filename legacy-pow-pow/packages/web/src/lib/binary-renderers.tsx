/**
 * Pluggable binary asset renderer system
 *
 * Provides shared rendering logic for binary files (images, audio, video, PDF, etc.)
 * with support for both inline (chat) and full-pane (artifact preview) modes.
 */
import React from 'react'
import { File, FileAudio, Download } from 'lucide-react'
import { getBinaryAssetType } from './artifact-icons'

export type BinaryAssetType = 'image' | 'audio' | 'video' | 'pdf' | 'other'

export interface BinaryRendererProps {
  /** URL to the asset */
  assetUrl: string
  /** Artifact slug (used for filename in downloads) */
  slug: string
  /** MIME content type */
  contentType?: string
  /** Title/alt text for the asset */
  title?: string
  /** Click handler (for navigation to full view) */
  onClick?: () => void
  /** File size in bytes (for fallback renderer) */
  fileSize?: number
}

/**
 * Render mode for binary assets
 * - inline: Compact preview for chat messages (thumbnails, minimal controls)
 * - full: Full-pane preview in artifact focus panel (larger, more controls)
 */
export type RenderMode = 'inline' | 'full'

// ============================================================================
// Individual Renderers
// ============================================================================

/** Image renderer - shows the image with appropriate sizing */
export function ImageRenderer({ assetUrl, slug, title, onClick, mode }: BinaryRendererProps & { mode: RenderMode }) {
  if (mode === 'inline') {
    return (
      <button
        onClick={onClick}
        className="block rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
      >
        <img
          src={assetUrl}
          alt={title || slug}
          className="max-w-full max-h-80"
          loading="lazy"
        />
      </button>
    )
  }

  // Full mode
  return (
    <div className="flex flex-col items-center justify-center p-4">
      <img
        src={assetUrl}
        alt={title || slug}
        className="max-w-full max-h-[60vh] object-contain rounded border border-border"
      />
    </div>
  )
}

/** Audio renderer - shows audio player */
export function AudioRenderer({ assetUrl, contentType, mode }: BinaryRendererProps & { mode: RenderMode }) {
  if (mode === 'inline') {
    return (
      <div className="max-w-md">
        <audio controls className="w-full h-10" preload="metadata">
          <source src={assetUrl} type={contentType} />
        </audio>
      </div>
    )
  }

  // Full mode
  return (
    <div className="flex flex-col items-center justify-center p-8 gap-4">
      <FileAudio className="h-16 w-16 text-muted-foreground" />
      <audio controls className="w-full max-w-md">
        <source src={assetUrl} type={contentType} />
        Your browser does not support audio playback.
      </audio>
    </div>
  )
}

/** Video renderer - shows video player with play overlay for inline */
export function VideoRenderer({ assetUrl, contentType, onClick, mode }: BinaryRendererProps & { mode: RenderMode }) {
  if (mode === 'inline') {
    return (
      <button
        onClick={onClick}
        className="block rounded-lg overflow-hidden border border-border hover:border-primary transition-colors relative group"
      >
        <video
          src={assetUrl}
          className="max-w-full max-h-80"
          preload="metadata"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
          <svg className="w-12 h-12 text-white/80" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    )
  }

  // Full mode
  return (
    <div className="flex flex-col items-center justify-center p-4">
      <video
        controls
        className="max-w-full max-h-[60vh] rounded border border-border"
      >
        <source src={assetUrl} type={contentType} />
        Your browser does not support video playback.
      </video>
    </div>
  )
}

/** PDF renderer - embedded iframe for full mode, no inline preview */
export function PdfRenderer({ assetUrl, slug, mode }: BinaryRendererProps & { mode: RenderMode }) {
  if (mode === 'inline') {
    // PDFs don't get inline preview - return null
    return null
  }

  // Full mode - embedded viewer
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <iframe
        src={assetUrl}
        className="flex-1 w-full min-h-[400px] rounded border border-border"
        title={slug}
      />
    </div>
  )
}

/** Format file size for display */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Fallback renderer for unknown binary types - shows metadata and download */
export function FallbackRenderer({ assetUrl, slug, contentType, fileSize, mode }: BinaryRendererProps & { mode: RenderMode }) {
  if (mode === 'inline') {
    // No inline preview for unknown types
    return null
  }

  // Full mode - show file info and download
  return (
    <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
      <File className="h-16 w-16 text-muted-foreground" />
      <div className="space-y-1">
        <div className="text-sm font-medium">{slug}</div>
        <div className="text-xs text-muted-foreground">
          {contentType || 'Unknown type'}
          {fileSize !== undefined && ` • ${formatFileSize(fileSize)}`}
        </div>
      </div>
      <a
        href={assetUrl}
        download={slug}
        className="inline-flex items-center gap-2 px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 text-sm"
      >
        <Download className="h-4 w-4" />
        Download
      </a>
    </div>
  )
}

// ============================================================================
// Renderer Selection
// ============================================================================

/**
 * Get the appropriate renderer for a binary asset
 * Returns a render function that takes mode and returns JSX
 */
export function renderBinaryAsset(
  props: BinaryRendererProps,
  mode: RenderMode
): React.ReactNode {
  const assetType = getBinaryAssetType(props.contentType, props.slug)

  switch (assetType) {
    case 'image':
      return <ImageRenderer {...props} mode={mode} />
    case 'audio':
      return <AudioRenderer {...props} mode={mode} />
    case 'video':
      return <VideoRenderer {...props} mode={mode} />
    case 'pdf':
      return <PdfRenderer {...props} mode={mode} />
    default:
      return <FallbackRenderer {...props} mode={mode} />
  }
}

/**
 * Check if an asset type supports inline preview
 */
export function supportsInlinePreview(contentType?: string | null, slug?: string): boolean {
  const assetType = getBinaryAssetType(contentType, slug)
  // Only images, audio, and video get inline previews
  return assetType === 'image' || assetType === 'audio' || assetType === 'video'
}
