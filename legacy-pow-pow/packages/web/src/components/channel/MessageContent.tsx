import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getArtifactIcon, isBinaryAssetByEncoding, isBinaryAssetBySlug } from '@/lib/artifact-icons'
import { renderBinaryAsset, supportsInlinePreview } from '@/lib/binary-renderers'

interface ArtifactInfo {
  slug: string
  title: string
  type: string
  encoding?: string | null
  contentType?: string | null
  channel?: string
}

interface MessageContentProps {
  content: string
  myName: string
  channel?: string
  onArtifactClick?: (slug: string) => void
  artifacts?: ArtifactInfo[]
}

/** Compact inline preview for binary assets in chat - uses shared renderer system */
function AssetPreview({
  artifact,
  channel,
  onClick
}: {
  artifact: ArtifactInfo
  channel: string
  onClick?: () => void
}) {
  const assetUrl = `/boards/${encodeURIComponent(channel)}/${encodeURIComponent(artifact.slug)}`

  // Use the shared renderer in inline mode
  const rendered = renderBinaryAsset(
    {
      assetUrl,
      slug: artifact.slug,
      contentType: artifact.contentType || undefined,
      title: artifact.title,
      onClick,
    },
    'inline'
  )

  // Wrap in mt-2 for spacing consistency
  if (!rendered) return null
  return <div className="mt-2">{rendered}</div>
}

export function MessageContent({ content, myName, channel, onArtifactClick, artifacts = [] }: MessageContentProps) {
  // Check if content has markdown (code blocks, links, etc)
  const hasMarkdown = /```|`[^`]+`|\[.+\]\(.+\)|^\s*[-*]\s|^\s*\d+\.\s|^#+\s/m.test(content)

  // Build a map of slug -> artifact info for quick lookup
  const artifactMap = React.useMemo(() => {
    const map = new Map<string, ArtifactInfo>()
    for (const artifact of artifacts) {
      map.set(artifact.slug.toLowerCase(), artifact)
    }
    return map
  }, [artifacts])

  // Extract linked artifacts that should get inline previews
  const linkedPreviews = React.useMemo(() => {
    if (!channel) return []
    const linked: ArtifactInfo[] = []
    const regex = /\[\[([^\]]+)\]\]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const slug = match[1]
      const artifact = artifactMap.get(slug.toLowerCase())
      if (artifact && (isBinaryAssetByEncoding(artifact.encoding) || isBinaryAssetBySlug(artifact.slug))) {
        // Use shared utility to check if this asset type supports inline preview
        if (supportsInlinePreview(artifact.contentType, artifact.slug)) {
          linked.push(artifact)
        }
      }
    }
    return linked
  }, [content, artifactMap, channel])

  // Highlight @mentions and [[artifact]] links within text
  const highlightSpecial = (text: string): React.ReactNode[] => {
    // Defensive check for undefined/null text
    if (!text) return []

    const parts: React.ReactNode[] = []
    // Combined regex for @mentions and [[artifact]] links
    const regex = /@(channel|[\w-]+)|\[\[([^\]]+)\]\]/gi
    let lastIndex = 0
    let match
    let key = 0

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }

      if (match[1]) {
        // @mention - inline colored text like Slack
        const isMe = match[1].toLowerCase() === myName.toLowerCase()
        const isChannel = match[1].toLowerCase() === 'channel'
        parts.push(
          <span
            key={key++}
            className={cn(
              'font-medium',
              isChannel ? 'text-purple-400' :
              isMe ? 'text-yellow-400' :
              'text-sky-400'
            )}
          >
            {match[0]}
          </span>
        )
      } else if (match[2]) {
        // [[artifact]] link - show title with type icon
        const slug = match[2]
        const artifact = artifactMap.get(slug.toLowerCase())
        const title = artifact?.title || slug
        // Get icon from shared utility, fall back to FileQuestion if artifact not found
        const Icon = artifact
          ? getArtifactIcon({ slug, type: artifact.type, encoding: artifact.encoding, contentType: artifact.contentType })
          : FileQuestion
        parts.push(
          <button
            key={key++}
            onClick={() => onArtifactClick?.(slug)}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {title}
          </button>
        )
      }

      lastIndex = regex.lastIndex
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex))
    }

    return parts.length ? parts : [text]
  }

  // Process children recursively to highlight mentions and artifact links in text nodes
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    return React.Children.map(children, child => {
      if (typeof child === 'string') {
        return <>{highlightSpecial(child)}</>
      }
      if (React.isValidElement(child) && child.props.children) {
        return React.cloneElement(child, {
          ...child.props,
          children: processChildren(child.props.children)
        } as React.HTMLAttributes<HTMLElement>)
      }
      return child
    })
  }

  // Render inline previews for binary assets
  const renderPreviews = () => {
    if (!channel || linkedPreviews.length === 0) return null
    return (
      <div className="flex flex-wrap gap-2">
        {linkedPreviews.map((artifact) => (
          <AssetPreview
            key={artifact.slug}
            artifact={artifact}
            channel={channel}
            onClick={() => onArtifactClick?.(artifact.slug)}
          />
        ))}
      </div>
    )
  }

  // For markdown content, render with Markdown component then highlight mentions
  if (hasMarkdown) {
    return (
      <>
        <Markdown
          className="prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="mb-1 last:mb-0">{processChildren(children)}</p>,
            code: ({ children, className, node }) => {
              // Check if this is a block (inside pre) or inline code
              const isBlock = node?.position?.start.line !== node?.position?.end.line ||
                             className?.includes('language-') ||
                             (typeof children === 'string' && children.includes('\n'))
              // Don't process mentions inside code blocks
              return isBlock ? (
                <code className={className}>{children}</code>
              ) : (
                <code className="bg-secondary rounded px-1 py-0.5 text-xs">{children}</code>
              )
            },
            pre: ({ children }) => (
              <pre className="bg-secondary rounded p-2 overflow-x-auto text-xs my-2 whitespace-pre-wrap">
                {children}
              </pre>
            ),
            a: ({ href, children }) => (
              <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full text-sm border border-border">{children}</table>
              </div>
            ),
            th: ({ children }) => <th className="px-2 py-1 bg-secondary border border-border text-left font-medium">{children}</th>,
            td: ({ children }) => <td className="px-2 py-1 border border-border">{children}</td>,
            ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li className="pl-1">{processChildren(children)}</li>,
            text: ({ children }) => <>{processChildren(children)}</>,
          }}
        >
          {content}
        </Markdown>
        {renderPreviews()}
      </>
    )
  }

  // Simple text with @mentions and [[artifact]] links
  return (
    <>
      <span>{highlightSpecial(content)}</span>
      {renderPreviews()}
    </>
  )
}
