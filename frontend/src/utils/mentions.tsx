import type { ReactNode } from 'react'
import { FileQuestion } from 'lucide-react'
import { getArtifactIcon } from '../lib/artifact-icons'

// Combined regex for @mentions and [[artifact]] links
const SPECIAL_SYNTAX_REGEX = /@([\w-]+)|\[\[([^\]]+)\]\]/g

/** Artifact info for title and icon lookup */
export interface ArtifactInfo {
  slug: string
  title?: string
  type: string
  contentType?: string | null
}

interface HighlightOptions {
  /** Current user's callsign - mentions of this name get highlighted differently */
  myName?: string
  /** Callback when an artifact link is clicked */
  onArtifactClick?: (slug: string) => void
  /** Artifact data for title and icon lookup (slug → ArtifactInfo) */
  artifacts?: Map<string, ArtifactInfo>
}

/**
 * Get the CSS class for a mention based on who is mentioned.
 * - @channel: purple (broadcast to all)
 * - @myName: yellow (needs my attention)
 * - @other: blue (regular mention)
 */
function getMentionClass(mention: string, myName?: string): string {
  const lower = mention.toLowerCase()
  if (lower === 'channel') {
    return 'mention mention-channel'
  }
  if (myName && lower === myName.toLowerCase()) {
    return 'mention mention-me'
  }
  return 'mention mention-other'
}

/**
 * Parses text and highlights @mentions and [[artifact]] links.
 *
 * @mentions are color-coded:
 * - @channel: purple (broadcast)
 * - @myName: yellow (needs attention)
 * - @others: blue (regular mention)
 */
export function highlightMentions(
  text: string,
  options: HighlightOptions = {}
): ReactNode[] {
  const { myName, onArtifactClick, artifacts } = options
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  SPECIAL_SYNTAX_REGEX.lastIndex = 0

  while ((match = SPECIAL_SYNTAX_REGEX.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    if (match[1]) {
      // @mention - group 1
      const mention = match[1]
      const mentionClass = getMentionClass(mention, myName)
      parts.push(
        <span key={`mention-${match.index}`} className={mentionClass}>
          @{mention}
        </span>
      )
    } else if (match[2]) {
      // [[artifact]] link - group 2
      const slug = match[2]
      const artifact = artifacts?.get(slug.toLowerCase())
      const displayTitle = artifact?.title || slug

      // Get icon based on artifact type, or fallback to FileQuestion if unknown
      const Icon = artifact
        ? getArtifactIcon({
            slug,
            type: artifact.type,
            contentType: artifact.contentType
          })
        : FileQuestion

      parts.push(
        <span
          key={`artifact-${match.index}`}
          className="artifact-link"
          onClick={onArtifactClick ? () => onArtifactClick(slug) : undefined}
          role={onArtifactClick ? 'button' : undefined}
          tabIndex={onArtifactClick ? 0 : undefined}
        >
          <Icon className="artifact-icon w-3.5 h-3.5" />
          {displayTitle}
        </span>
      )
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

/**
 * Checks if a message contains a specific @mention
 */
export function hasMention(text: string, callsign: string): boolean {
  const regex = new RegExp(`@${callsign}\\b`, 'i')
  return regex.test(text)
}

/**
 * Extracts all @mentions from text
 */
export function extractMentions(text: string): string[] {
  const mentionRegex = /@(\w+)/g
  const mentions: string[] = []
  let match: RegExpExecArray | null

  while ((match = mentionRegex.exec(text)) !== null) {
    mentions.push(match[1])
  }

  return [...new Set(mentions)] // dedupe
}

/**
 * Extracts all [[artifact]] references from text
 */
export function extractArtifactRefs(text: string): string[] {
  const artifactRegex = /\[\[([^\]]+)\]\]/g
  const refs: string[] = []
  let match: RegExpExecArray | null

  while ((match = artifactRegex.exec(text)) !== null) {
    refs.push(match[1])
  }

  return [...new Set(refs)] // dedupe
}
