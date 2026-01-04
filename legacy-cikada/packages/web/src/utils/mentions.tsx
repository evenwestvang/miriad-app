import type { ReactNode } from 'react'

// Combined regex for @mentions and [[artifact]] links
const SPECIAL_SYNTAX_REGEX = /@(\w+)|\[\[([^\]]+)\]\]/g

interface HighlightOptions {
  onArtifactClick?: (slug: string) => void
}

/**
 * Parses text and highlights @mentions and [[artifact]] links
 */
export function highlightMentions(
  text: string,
  options: HighlightOptions = {}
): ReactNode[] {
  const { onArtifactClick } = options
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
      parts.push(
        <span key={`mention-${match.index}`} className="mention">
          @{match[1]}
        </span>
      )
    } else if (match[2]) {
      // [[artifact]] link - group 2
      const slug = match[2]
      parts.push(
        <span
          key={`artifact-${match.index}`}
          className="artifact-link"
          onClick={onArtifactClick ? () => onArtifactClick(slug) : undefined}
          role={onArtifactClick ? 'button' : undefined}
          tabIndex={onArtifactClick ? 0 : undefined}
        >
          <span className="artifact-icon">📄</span>
          {slug}
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
