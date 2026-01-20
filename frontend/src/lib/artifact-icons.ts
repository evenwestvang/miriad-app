/**
 * Single source of truth for artifact icons across the app.
 * Ported from legacy-pow-pow with the same cascading priority logic.
 */
import {
  FileText,
  Code,
  CheckSquare,
  Square,
  HelpCircle,
  SquarePlay,
  Image,
  FileAudio,
  FileVideo,
  File,
  Folder,
  CircleEllipsis,
  BookOpen,
  Target,
  Library,
  Plug,
  Plug2,
  KeyRound,
  type LucideIcon
} from 'lucide-react'

// File extension categories
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg']
const VIDEO_EXTENSIONS = ['mp4', 'webm']
const BINARY_EXTENSIONS = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, 'pdf', 'zip', 'woff', 'woff2', 'ttf', 'wasm']

// Type-based icons
const TYPE_ICONS: Record<string, LucideIcon> = {
  doc: FileText,
  folder: Folder,
  code: Code,
  task: CheckSquare,
  decision: HelpCircle,
  knowledgebase: Library,
  'system.agent': CircleEllipsis,
  'system.playbook': BookOpen,
  'system.focus': Target,
  'system.mcp': Plug,
  'system.environment': KeyRound,
  'system.app': Plug2,
}

// Binary type icons
const BINARY_TYPE_ICONS = {
  image: Image,
  audio: FileAudio,
  video: FileVideo,
  pdf: FileText,
  other: File,
} as const

type BinaryAssetType = keyof typeof BINARY_TYPE_ICONS

/**
 * Check if a slug represents an interactive SPA artifact
 */
export function isSpaArtifact(slug: string): boolean {
  return slug.endsWith('.app.js')
}

/**
 * Check if a slug represents a binary asset based on extension
 */
export function isBinaryAssetBySlug(slug: string): boolean {
  const ext = slug.split('.').pop()?.toLowerCase()
  return ext ? BINARY_EXTENSIONS.includes(ext) : false
}

/**
 * Check if an artifact is a binary asset based on type field
 */
export function isBinaryAssetByType(type: string): boolean {
  return type === 'asset'
}

/**
 * Get the binary asset type from contentType or slug extension
 */
export function getBinaryAssetType(contentType?: string | null, slug?: string): BinaryAssetType {
  // Try contentType first
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image'
    if (contentType.startsWith('audio/')) return 'audio'
    if (contentType.startsWith('video/')) return 'video'
    if (contentType === 'application/pdf') return 'pdf'
  }

  // Fall back to extension
  if (slug) {
    const ext = slug.split('.').pop()?.toLowerCase()
    if (ext) {
      if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
      if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
      if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
      if (ext === 'pdf') return 'pdf'
    }
  }

  return 'other'
}

/**
 * Get the appropriate icon for an artifact.
 *
 * Priority:
 * 1. Task status (done = CheckSquare, other = Square)
 * 2. Interactive SPA (.app.js)
 * 3. Binary asset (by type='asset' or extension)
 * 4. Type-based icon
 * 5. Default to FileText
 */
export function getArtifactIcon(artifact: {
  slug: string
  type: string
  status?: string
  contentType?: string | null
}): LucideIcon {
  // Tasks get special treatment based on status
  if (artifact.type === 'task') {
    return artifact.status === 'done' ? CheckSquare : Square
  }

  // Interactive SPA
  if (isSpaArtifact(artifact.slug)) {
    return SquarePlay
  }

  // Binary asset (check type first, then fall back to extension)
  if (isBinaryAssetByType(artifact.type) || isBinaryAssetBySlug(artifact.slug)) {
    const assetType = getBinaryAssetType(artifact.contentType, artifact.slug)
    return BINARY_TYPE_ICONS[assetType]
  }

  // Type-based icon
  return TYPE_ICONS[artifact.type] || FileText
}

/**
 * Get type label for display
 */
export function getArtifactTypeLabel(artifact: {
  slug: string
  type: string
  contentType?: string | null
}): string {
  // Interactive SPA
  if (isSpaArtifact(artifact.slug)) {
    return 'Interactive'
  }

  // Binary asset
  if (isBinaryAssetByType(artifact.type) || isBinaryAssetBySlug(artifact.slug)) {
    const assetType = getBinaryAssetType(artifact.contentType, artifact.slug)
    const labels: Record<BinaryAssetType, string> = {
      image: 'Image',
      audio: 'Audio',
      video: 'Video',
      pdf: 'PDF',
      other: 'Binary',
    }
    return labels[assetType]
  }

  // Type-based label
  const labels: Record<string, string> = {
    doc: 'Document',
    folder: 'Folder',
    code: 'Code',
    task: 'Task',
    decision: 'Decision',
    knowledgebase: 'Knowledge Base',
    'system.agent': 'Agent',
    'system.playbook': 'Playbook',
    'system.focus': 'Focus',
    'system.mcp': 'MCP Server',
    'system.environment': 'Environment',
    'system.app': 'App',
  }
  return labels[artifact.type] || artifact.type
}
