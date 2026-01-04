import { useRef, useLayoutEffect, useCallback } from 'react'
import { Message, StructuredAskMessage, AnyMessage } from '@/types'
import { ChannelAgent } from '@/api'
import { formatTime } from '@/utils'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MessageContent } from './MessageContent'
import { StructuredAskForm } from './StructuredAskForm'

interface ArtifactInfo {
  slug: string
  title: string
  type: string
  encoding?: string | null
  contentType?: string | null
}

interface MessageListProps {
  messages: AnyMessage[]
  myName: string
  channel: string
  onLoadMore: () => void
  hasMore: boolean
  channelAgents: ChannelAgent[]
  onArtifactClick?: (slug: string) => void
  artifacts?: ArtifactInfo[]
  onStructuredAskSubmit?: (messageId: string, values: Record<string, string | string[]>) => void
}

export function MessageList({
  messages,
  myName,
  channel,
  onLoadMore,
  hasMore,
  channelAgents,
  onArtifactClick,
  artifacts = [],
  onStructuredAskSubmit,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const prevMessagesLengthRef = useRef(0)

  // Build map of agent names to their type (agentSlug) for quick lookup
  const agentTypeMap = new Map<string, string>()
  for (const agent of channelAgents) {
    if (agent.name) {
      agentTypeMap.set(agent.name.toLowerCase(), agent.agentSlug || 'agent')
    }
  }

  // Track if user is at bottom on every scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const { scrollTop, scrollHeight, clientHeight } = container
    wasAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20

    // Load more when scrolling to top
    if (scrollTop < 50 && hasMore) {
      onLoadMore()
    }
  }, [hasMore, onLoadMore])

  // Auto-scroll: if was at bottom, smash to bottom immediately
  useLayoutEffect(() => {
    if (messages.length === 0) return

    // First load or was at bottom - snap immediately
    if (prevMessagesLengthRef.current === 0 || wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView()
      wasAtBottomRef.current = true
    }
    prevMessagesLengthRef.current = messages.length
  }, [messages])

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-1"
    >
      {hasMore && (
        <Button
          variant="ghost"
          onClick={onLoadMore}
          className="w-full text-muted-foreground"
        >
          Load older messages...
        </Button>
      )}

      {messages.map((msg, index) => {
        const sender = msg.sender || 'unknown'
        const msgKey = msg.id || `msg-${index}`
        const agentType = agentTypeMap.get(sender.toLowerCase())
        const isAgent = !!agentType
        const isSystem = sender === 'system'
        const content = (msg as Message).content || ''

        // Handle structured ask messages
        if (msg.type === 'structured_ask') {
          const askMsg = msg as StructuredAskMessage
          return (
            <div key={msgKey} className="py-1 pb-3 hover:bg-secondary/50 px-2 -mx-2 rounded">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  'font-medium text-sm',
                  sender === myName ? 'text-green-500' : 'text-primary'
                )}>
                  {sender}
                </span>
                {isAgent && agentType && (
                  <span className="text-muted-foreground text-xs">({agentType})</span>
                )}
                <span className="text-muted-foreground text-xs">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="pl-3">
                <StructuredAskForm
                  message={askMsg}
                  myName={myName}
                  onSubmit={onStructuredAskSubmit || (() => {})}
                />
              </div>
            </div>
          )
        }

        // Handle system messages (centered, muted, no avatar)
        if (isSystem) {
          return (
            <div key={msgKey} className="py-2 group">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="flex-1 border-t border-border/50" />
                <span className="group-hover:text-foreground/70 transition-colors">
                  {content}
                </span>
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                  {formatTime(msg.timestamp)}
                </span>
                <div className="flex-1 border-t border-border/50" />
              </div>
            </div>
          )
        }

        // Regular message
        return (
        <div key={msgKey} className="py-1 pb-3 hover:bg-secondary/50 px-2 -mx-2 rounded">
          <div className="flex items-baseline gap-2">
            <span className={cn(
              'font-medium text-sm',
              sender === myName ? 'text-green-500' : 'text-primary'
            )}>
              {sender}
            </span>
            {isAgent && agentType && (
              <span className="text-muted-foreground text-xs">({agentType})</span>
            )}
            <span className="text-muted-foreground text-xs">{formatTime(msg.timestamp)}</span>
          </div>
          <div className="text-foreground pl-3 text-[15px] leading-relaxed">
            <MessageContent content={content} myName={myName} channel={channel} onArtifactClick={onArtifactClick} artifacts={artifacts} />
          </div>
        </div>
      )})}

      <div ref={bottomRef} />
    </div>
  )
}
