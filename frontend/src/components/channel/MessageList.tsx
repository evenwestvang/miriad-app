import { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react'
import Markdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Message, StructuredAskMessage } from '../../types'
import { highlightMentions, type ArtifactInfo } from '../../utils'
import { ToolMessage } from './ToolMessage'
import { StructuredAskForm } from '../structured-ask'
import { AttachmentList, AttachmentRenderer } from './AttachmentRenderer'
import type { AttachmentMessageContent, Attachment } from '../../types'
// Avatar components kept for potential future use
// import { AgentAvatar, UserAvatar } from './AgentAvatar'
import { Cartouche } from './Cartouche'
import type { RosterAgent } from './MentionAutocomplete'
import { apiFetch } from '../../lib/api'
import { useIsDarkMode } from '../../hooks/useIsDarkMode'

interface MessageListProps {
  messages: Message[]
  threadName?: string
  threadAgentType?: string
  myName?: string
  /** API host for attachment URLs */
  apiHost?: string
  /** Channel ID for artifact lookup */
  channelId?: string
  /** Roster for agent type lookup */
  roster?: RosterAgent[]
  /** True immediately when channel switch starts (hides empty state) */
  isSwitching?: boolean
  /** Show loading spinner (delayed - only after 500ms) */
  isLoading?: boolean
  onStructuredAskSubmit?: (messageId: string, response: Record<string, unknown>) => void
}

export function MessageList({ messages, threadName = 'Agent', threadAgentType, myName = '', apiHost = '', channelId = '', roster = [], isSwitching = false, isLoading = false, onStructuredAskSubmit }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Create callsign → agentType lookup map from roster
  const agentTypeMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const agent of roster) {
      if (agent.agentType) {
        map.set(agent.callsign, agent.agentType)
      }
    }
    return map
  }, [roster])
  const wasAtBottomRef = useRef(true)
  // Track sync state: 'waiting' = no messages yet, 'syncing' = first batch arriving, 'ready' = sync complete
  const syncStateRef = useRef<'waiting' | 'syncing' | 'ready'>('waiting')
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevMessageCountRef = useRef(0)

  // Artifact map for [[slug]] title lookup
  const [artifactMap, setArtifactMap] = useState<Map<string, ArtifactInfo>>(new Map())

  // Fetch artifacts for title lookup - delayed to not compete with initial paint
  useEffect(() => {
    if (!channelId || !apiHost || isLoading) {
      if (!channelId) setArtifactMap(new Map())
      return
    }

    const timeoutId = setTimeout(() => {
      async function fetchArtifacts() {
        console.log(`[ChannelSwitch] Starting artifacts fetch at ${performance.now().toFixed(2)}ms`)
        try {
          const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts?limit=500`)
          if (!response.ok) return
          const data = await response.json()
          console.log(`[ChannelSwitch] Artifacts fetch complete at ${performance.now().toFixed(2)}ms`)
          const artifacts = data.artifacts || []

          const map = new Map<string, ArtifactInfo>()
          for (const artifact of artifacts) {
            map.set(artifact.slug.toLowerCase(), {
              slug: artifact.slug,
              title: artifact.title,
              type: artifact.type,
              encoding: artifact.encoding,
              contentType: artifact.contentType,
            })
          }
          setArtifactMap(map)
        } catch (error) {
          console.warn('Failed to fetch artifacts for title lookup:', error)
        }
      }
      fetchArtifacts()
    }, 250) // Delay to not compete with initial message sync

    return () => clearTimeout(timeoutId)
  }, [channelId, apiHost, isLoading])

  // Check if user is at bottom before messages update
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return true
    const threshold = 50 // pixels from bottom to consider "at bottom"
    return container.scrollHeight - container.scrollTop <= container.clientHeight + threshold
  }, [])

  // Track scroll position
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      wasAtBottomRef.current = checkIfAtBottom()
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [checkIfAtBottom])

  // Reset sync state when channel changes (messages cleared)
  useEffect(() => {
    if (messages.length === 0) {
      syncStateRef.current = 'waiting'
      prevMessageCountRef.current = 0
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
        syncTimeoutRef.current = null
      }
    }
  }, [messages.length === 0])

  // Handle scrolling based on sync state
  useLayoutEffect(() => {
    const prevCount = prevMessageCountRef.current
    const currentCount = messages.length
    prevMessageCountRef.current = currentCount

    if (currentCount === 0) {
      return
    }

    // Detect sync start: going from 0 to having messages
    if (prevCount === 0 && currentCount > 0) {
      syncStateRef.current = 'syncing'
    }

    // During sync: keep scrolling to bottom instantly (no animation)
    if (syncStateRef.current === 'syncing' && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      wasAtBottomRef.current = true

      // Reset the sync completion timer on each new message
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
      // After 150ms of no new messages, consider sync complete
      syncTimeoutRef.current = setTimeout(() => {
        syncStateRef.current = 'ready'
        syncTimeoutRef.current = null
      }, 150)
      return
    }

    // After sync complete: smooth scroll for new messages if at bottom
    if (syncStateRef.current === 'ready' && wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  return (
    <div className="flex-1 overflow-y-auto p-6" ref={containerRef}>
      {messages.length === 0 ? (
        isSwitching ? (
          // Channel switch in progress
          isLoading ? (
            // Show spinner after 500ms delay
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin mb-4" />
              <p className="text-muted-foreground text-sm">Loading messages...</p>
            </div>
          ) : (
            // Before 500ms - show nothing (blank screen feels faster)
            null
          )
        ) : (
          // Empty state - only show when NOT switching channels
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <span className="text-2xl">💬</span>
            </div>
            <p className="text-muted-foreground text-sm mb-1">
              Start a conversation with {threadName}
            </p>
            {threadAgentType && (
              <p className="text-xs text-muted-foreground">
                This is a {threadAgentType} agent
              </p>
            )}
          </div>
        )
      ) : (
        messages.map((message, index) => {
          // Check if this message should show the header
          // Show header if: first message, different sender, or >20 min gap
          const prevMessage = index > 0 ? messages[index - 1] : null
          const showHeader = !prevMessage ||
            prevMessage.sender !== message.sender ||
            prevMessage.senderType !== message.senderType ||
            (new Date(message.timestamp).getTime() - new Date(prevMessage.timestamp).getTime()) > 20 * 60 * 1000

          // Check if next message starts a new group (determines bottom margin)
          const nextMessage = index < messages.length - 1 ? messages[index + 1] : null
          const isLastInGroup = !nextMessage ||
            nextMessage.sender !== message.sender ||
            nextMessage.senderType !== message.senderType ||
            (new Date(nextMessage.timestamp).getTime() - new Date(message.timestamp).getTime()) > 20 * 60 * 1000

          // Within a group: small margin. End of group: large margin.
          const marginClass = isLastInGroup ? "mb-8 last:mb-0" : "mb-1"

          return (
            <div key={message.id} data-message-id={message.id} className={marginClass}>
              <MessageItem
                message={message}
                threadName={threadName}
                myName={myName}
                apiHost={apiHost}
                artifacts={artifactMap}
                agentType={message.sender ? agentTypeMap.get(message.sender) : threadAgentType}
                onStructuredAskSubmit={onStructuredAskSubmit}
                showHeader={showHeader}
              />
            </div>
          )
        })
      )}
      <div ref={bottomRef} />
    </div>
  )
}

interface MessageItemProps {
  message: Message
  threadName?: string
  myName?: string
  /** API host for attachment URLs */
  apiHost?: string
  /** Artifact map for [[slug]] title lookup */
  artifacts?: Map<string, ArtifactInfo>
  /** Agent type for cartouche color scheme */
  agentType?: string
  onStructuredAskSubmit?: (messageId: string, response: Record<string, unknown>) => void
  /** Whether to show the header (glyph, name, timestamp). False for consecutive messages from same sender. */
  showHeader?: boolean
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


function MessageItem({ message, threadName = 'Agent', myName = '', apiHost = '', artifacts, agentType, onStructuredAskSubmit, showHeader = true }: MessageItemProps) {
  const isDarkMode = useIsDarkMode()
  const isUser = message.senderType === 'user'
  const hasAttachments = message.attachments && message.attachments.length > 0

  // Get display name: use sender if available, fallback to myName/threadName
  const displayName = message.sender && message.sender !== 'agent'
    ? message.sender
    : (isUser ? (myName || 'You') : threadName)

  // Special handling for structured_ask messages
  // API returns formData nested inside message.content as JSON
  const contentObj = message.type === 'structured_ask' && message.content && typeof message.content === 'object'
    ? message.content as Record<string, unknown>
    : null
  const hasFormData = contentObj && 'formData' in contentObj

  if (message.type === 'structured_ask' && hasFormData) {
    // Transform to StructuredAskMessage shape expected by the form component
    const structuredAskMessage: StructuredAskMessage = {
      id: message.id,
      channelId: message.channelId,
      type: 'structured_ask',
      sender: message.sender,
      timestamp: message.timestamp,
      content: typeof contentObj.prompt === 'string' ? contentObj.prompt : '',
      formData: contentObj.formData as StructuredAskMessage['formData'],
      formState: (contentObj.formState as StructuredAskMessage['formState']) || 'pending',
      response: contentObj.response as Record<string, unknown> | undefined,
      respondedBy: contentObj.respondedBy as string | undefined,
      respondedAt: contentObj.respondedAt as string | undefined,
    }

    return (
      <div className="flex flex-col min-w-0 max-w-[90%]">
        {/* Header line with glyph, callsign, timestamp - pulled left (only for first in group) */}
        {showHeader && (
          <div className="flex items-center gap-2 mb-1.5 -ml-4">
            <Cartouche name={message.sender || displayName} agentType={agentType} className="text-[14px]" />
            <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
              {displayName}
            </span>
            <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
              {formatTime(message.timestamp)}
            </span>
          </div>
        )}
        {/* Content - normal position */}
        <StructuredAskForm
          message={structuredAskMessage}
          myName={myName}
          onSubmit={onStructuredAskSubmit || (() => {})}
        />
      </div>
    )
  }

  // Special handling for tool calls and results - use dedicated component
  if (message.type === 'tool_call' || message.type === 'tool_result') {
    return <ToolMessage message={message} />
  }

  // Helper to extract text content (may be string or { text: "..." } object)
  const getTextContent = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (content && typeof content === 'object' && 'text' in content) {
      return (content as { text: string }).text
    }
    return ''
  }

  // Error messages
  if (message.type === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
        <span>❌</span>
        <span>{highlightMentions(getTextContent(message.content), { myName, artifacts })}</span>
      </div>
    )
  }

  // Status messages
  if (message.type === 'status') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
        <span>⏳</span>
        <span>{highlightMentions(getTextContent(message.content), { myName, artifacts })}</span>
      </div>
    )
  }

  // Attachment messages - display file with optional title/description
  if (message.type === 'attachment' && apiHost) {
    // Parse content as attachment data (may be string or object)
    let attachmentData: AttachmentMessageContent | null = null
    try {
      if (typeof message.content === 'string' && message.content.startsWith('{')) {
        attachmentData = JSON.parse(message.content) as AttachmentMessageContent
      } else if (typeof message.content === 'object' && message.content !== null) {
        attachmentData = message.content as unknown as AttachmentMessageContent
      }
    } catch {
      // Fall through to show error
    }

    if (!attachmentData) {
      return (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
          <span>❌</span>
          <span>Invalid attachment data</span>
        </div>
      )
    }

    // Convert to Attachment type for the renderer
    const attachment: Attachment = {
      id: attachmentData.attachmentId,
      channelId: message.channelId,
      messageId: message.id,
      filename: attachmentData.filename,
      mimeType: attachmentData.mimeType,
      size: attachmentData.size,
      url: attachmentData.url,
      uploadedBy: message.sender,
      uploadedAt: message.timestamp,
    }

    return (
      <div className="flex flex-col min-w-0 max-w-[80%]">
        {/* Header line with glyph, callsign, timestamp - pulled left (only for first in group) */}
        {showHeader && (
          <div className="flex items-center gap-2 mb-1.5 -ml-4">
            <Cartouche name={message.sender || displayName} agentType={agentType} className="text-[14px]" />
            <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
              {displayName}
            </span>
            <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
              {formatTime(message.timestamp)}
            </span>
          </div>
        )}
        {/* Content - normal position */}
        <div className="bg-card border border-border overflow-hidden">
          {/* Title - show prominently if provided */}
          {attachmentData.title && (
            <div className="px-3 py-2 border-b border-border bg-secondary/30">
              <div className="font-medium text-sm">{attachmentData.title}</div>
            </div>
          )}
          {/* Attachment preview */}
          <div className="p-3">
            <AttachmentRenderer
              attachment={attachment}
              apiHost={apiHost}
              compact={false}
            />
          </div>
          {/* Description - show below if provided */}
          {attachmentData.description && (
            <div className="px-3 py-2 border-t border-border bg-secondary/20">
              <p className="text-sm text-muted-foreground">{attachmentData.description}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Regular user/assistant messages
  return (
    <div className="flex flex-col min-w-0">
      {/* Header line with glyph, callsign, timestamp - pulled left (only for first in group) */}
      {showHeader && (
        <div className="flex items-center gap-2 mb-1.5 -ml-4">
          <Cartouche name={message.sender || displayName} agentType={agentType} className="text-[14px]" />
          <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
            {displayName}
          </span>
          <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
            {formatTime(message.timestamp)}
          </span>
        </div>
      )}
      {/* Content - normal position */}
      <div className="message-content">
        {renderMessageContent(message, myName, artifacts, isDarkMode)}
      </div>
      {/* Render attachments below the message */}
      {hasAttachments && apiHost && (
        <AttachmentList
          attachments={message.attachments!}
          apiHost={apiHost}
          compact
          className="mt-2"
        />
      )}
    </div>
  )
}

/**
 * Create markdown components that highlight @mentions and [[slug]] links.
 */
function createMarkdownComponents(myName: string, artifacts?: Map<string, ArtifactInfo>, isDarkMode?: boolean): Components {
  // Process children to highlight @mentions and [[slug]] links in text nodes
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    if (typeof children === 'string') {
      return highlightMentions(children, { myName, artifacts })
    }
    if (Array.isArray(children)) {
      return children.map((child, i) => {
        if (typeof child === 'string') {
          return <span key={i}>{highlightMentions(child, { myName, artifacts })}</span>
        }
        return child
      })
    }
    return children
  }

  // Select syntax highlighting theme based on mode
  const codeTheme = isDarkMode ? oneDark : oneLight

  return {
    // Override text rendering to highlight @mentions and [[slug]] links
    p: ({ children }) => <p>{processChildren(children)}</p>,
    li: ({ children }) => <li>{processChildren(children)}</li>,
    td: ({ children }) => <td>{processChildren(children)}</td>,
    th: ({ children }) => <th>{processChildren(children)}</th>,
    // Syntax highlighting for code blocks
    code: ({ className, children, node, ...props }) => {
      const match = /language-(\w+)/.exec(className || '')
      // Check if this is a code block: has language class, or parent is pre (node check), or has newlines
      const codeString = String(children)
      const hasNewlines = codeString.includes('\n')
      const isCodeBlock = match || hasNewlines

      if (!isCodeBlock) {
        // Inline code - render as styled span
        return (
          <code className="bg-secondary px-1.5 py-0.5 text-sm font-mono rounded" {...props}>
            {children}
          </code>
        )
      }

      // Code block - use syntax highlighter
      const language = match ? match[1] : 'text'
      return (
        <div className="not-prose">
          <SyntaxHighlighter
            style={codeTheme}
            language={language}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: '1rem',
              fontSize: '13px',
              lineHeight: '1.2',
              borderRadius: '0.25rem',
            }}
          >
            {codeString.replace(/\n$/, '')}
          </SyntaxHighlighter>
        </div>
      )
    },
    // Override pre to avoid double wrapping
    pre: ({ children }) => <>{children}</>,
  }
}

function renderMessageContent(message: Message, myName: string = '', artifacts?: Map<string, ArtifactInfo>, isDarkMode: boolean = false): React.ReactNode {
  // Handle content that may be a string or { text: "..." } object
  const content = typeof message.content === 'string'
    ? message.content
    : (message.content as { text?: string })?.text || ''

  // Create markdown components with myName for @mention highlighting and artifacts for [[slug]] lookup
  const markdownComponents = createMarkdownComponents(myName, artifacts, isDarkMode)

  // For user/assistant/thinking messages, render markdown
  return (
    <Markdown
      className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
    >
      {content}
    </Markdown>
  )
}
