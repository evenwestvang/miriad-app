import { useEffect, useRef, useCallback, useMemo } from 'react'
import Markdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, StructuredAskMessage } from '../../types'
import { highlightMentions } from '../../utils'
import { ToolMessage } from './ToolMessage'
import { StructuredAskForm } from '../structured-ask'
import { AttachmentList, AttachmentRenderer } from './AttachmentRenderer'
import type { AttachmentMessageContent, Attachment } from '../../types'
import { AgentAvatar, UserAvatar } from './AgentAvatar'
import type { RosterAgent } from './AgentRoster'

interface MessageListProps {
  messages: Message[]
  threadName?: string
  threadAgentType?: string
  myName?: string
  /** API host for attachment URLs */
  apiHost?: string
  /** Channel ID for avatar assignment */
  channelId?: string
  /** Current roster for agent index lookup */
  roster?: RosterAgent[]
  onStructuredAskSubmit?: (messageId: string, response: Record<string, unknown>) => void
}

export function MessageList({ messages, threadName = 'Agent', threadAgentType, myName = '', apiHost = '', channelId = '', roster = [], onStructuredAskSubmit }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const isInitialLoadRef = useRef(true)

  // Build callsign to roster index map for avatar assignment
  const callsignIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    roster.forEach((agent, index) => {
      map.set(agent.callsign, index)
    })
    return map
  }, [roster])

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

  // Auto-scroll only if user was at bottom
  // Use instant scroll on initial load, smooth scroll for subsequent updates
  useEffect(() => {
    if (messages.length === 0) {
      // Reset initial load flag when messages are cleared (channel change)
      isInitialLoadRef.current = true
      return
    }

    if (wasAtBottomRef.current) {
      if (isInitialLoadRef.current) {
        // Initial load: scroll instantly so it appears already at bottom
        bottomRef.current?.scrollIntoView({ behavior: 'instant' })
        isInitialLoadRef.current = false
      } else {
        // Subsequent updates: smooth scroll for new messages
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages])

  return (
    <div className="flex-1 overflow-y-auto p-6" ref={containerRef}>
      {messages.length === 0 ? (
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
      ) : (
        messages.map((message) => (
          <div key={message.id} data-message-id={message.id} className="mb-8 last:mb-0">
            <MessageItem
              message={message}
              threadName={threadName}
              myName={myName}
              apiHost={apiHost}
              channelId={channelId}
              agentIndex={callsignIndexMap.get(message.sender || '') ?? -1}
              onStructuredAskSubmit={onStructuredAskSubmit}
            />
          </div>
        ))
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
  /** Channel ID for avatar assignment */
  channelId?: string
  /** Agent's index in roster for avatar (-1 if not found) */
  agentIndex?: number
  onStructuredAskSubmit?: (messageId: string, response: Record<string, unknown>) => void
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


function MessageItem({ message, threadName = 'Agent', myName = '', apiHost = '', channelId = '', agentIndex = -1, onStructuredAskSubmit }: MessageItemProps) {
  const isUser = message.senderType === 'user'
  const isAgent = message.senderType === 'agent'
  const hasAttachments = message.attachments && message.attachments.length > 0

  // Get display name: use sender if available, fallback to threadName or defaults
  const displayName = isUser
    ? 'You'
    : (message.sender && message.sender !== 'agent' ? message.sender : threadName)

  // Avatar selection: agents get AgentAvatar, users get UserAvatar
  // For agents not in roster (agentIndex === -1), use a hash-based fallback index
  const getFallbackAgentIndex = (sender: string): number => {
    // Simple hash to get a consistent index for agents not in roster
    let hash = 0
    for (let i = 0; i < sender.length; i++) {
      hash = ((hash << 5) - hash) + sender.charCodeAt(i)
      hash = hash & hash
    }
    return Math.abs(hash) % 31 // 31 agent avatars available
  }

  const effectiveAgentIndex = agentIndex >= 0 ? agentIndex : getFallbackAgentIndex(message.sender || 'agent')

  // Render avatar based on senderType
  const renderAvatar = (className: string = '') => {
    if (isAgent && channelId) {
      return <AgentAvatar channelId={channelId} agentIndex={effectiveAgentIndex} displayName={displayName} className={className} />
    }
    return <UserAvatar userId={message.sender || 'user'} displayName={displayName} className={className} />
  }

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
      <div className="flex gap-4">
        {/* Avatar - centered with header row */}
        {renderAvatar('mt-[-10px]')}
        {/* Content */}
        <div className="flex flex-col min-w-0 max-w-[90%]">
          <div className="flex items-baseline gap-3 mb-1.5">
            <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
              {displayName}
            </span>
            <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
              {formatTime(message.timestamp)}
            </span>
          </div>
          <StructuredAskForm
            message={structuredAskMessage}
            myName={myName}
            onSubmit={onStructuredAskSubmit || (() => {})}
          />
        </div>
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
        <span>{highlightMentions(getTextContent(message.content))}</span>
      </div>
    )
  }

  // Status messages
  if (message.type === 'status') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
        <span>⏳</span>
        <span>{highlightMentions(getTextContent(message.content))}</span>
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
      <div className="flex gap-4">
        {/* Avatar */}
        {renderAvatar('mt-[-10px]')}
        {/* Content */}
        <div className="flex flex-col min-w-0 max-w-[80%]">
          <div className="flex items-baseline gap-3 mb-1.5">
            <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
              {displayName}
            </span>
            <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
              {formatTime(message.timestamp)}
            </span>
          </div>
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
      </div>
    )
  }

  // Regular user/assistant messages
  return (
    <div className="flex gap-4">
      {/* Avatar */}
      {renderAvatar('mt-[-10px]')}
      {/* Content */}
      <div className="flex flex-col min-w-0">
        <div className="flex items-baseline gap-3 mb-1.5">
          <span className="text-[14px] font-semibold text-[var(--cast-text-primary)] tracking-[-0.01em]">
            {displayName}
          </span>
          <span className="text-[14px] text-[var(--cast-text-muted)] tracking-[0.02em]">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div className="message-content">
          {renderMessageContent(message)}
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
    </div>
  )
}

// Custom markdown components that highlight @mentions
const markdownComponents: Components = {
  // Override text rendering to highlight @mentions
  p: ({ children }) => <p>{processChildren(children)}</p>,
  li: ({ children }) => <li>{processChildren(children)}</li>,
  td: ({ children }) => <td>{processChildren(children)}</td>,
  th: ({ children }) => <th>{processChildren(children)}</th>,
}

// Process children to highlight @mentions in text nodes
function processChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    return highlightMentions(children)
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        return <span key={i}>{highlightMentions(child)}</span>
      }
      return child
    })
  }
  return children
}

function renderMessageContent(message: Message): React.ReactNode {
  // Handle content that may be a string or { text: "..." } object
  const content = typeof message.content === 'string'
    ? message.content
    : (message.content as { text?: string })?.text || ''

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
