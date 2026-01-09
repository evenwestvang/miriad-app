import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { Message, MessageType, AgentState, AgentOutput } from '../types'
import { apiFetch, API_HOST } from '../lib/api'

// Artifact event from WebSocket stream
export interface ArtifactEvent {
  action: 'created' | 'updated' | 'archived'
  artifact: {
    slug: string
    channelId: string
    type: string
    title?: string
    tldr: string
    status: string
    parentSlug?: string
    [key: string]: unknown
  }
}

// Roster event from WebSocket stream
export interface RosterEvent {
  action: 'agent_joined' | 'agent_dismissed'
  agent: {
    callsign: string
    agentType: string
    status?: string
  }
}

// Tymbal protocol types
interface TymbalFrame {
  i: string // ULID
  t?: string // Timestamp (ISO)
  m?: MessageMetadata // Start frame metadata
  a?: string // Append content
  v?: MessageValue | null // Set value (null = reset)
  c?: string // Channel ID (server injects this for client routing)
  request?: string // Sync request
  error?: string // Error code
  message?: string // Error message
}

interface MessageMetadata {
  type: MessageType
  sender: string
  senderType: 'user' | 'agent'
}

interface MessageValue {
  type: MessageType
  content?: string
  sender: string
  senderType: 'user' | 'agent'
  // For agent_output frames
  agentOutput?: AgentOutput
  // For agent_state frames
  state?: AgentState
  toolName?: string
  // For tool_call frames (flat format)
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  // For tool_result frames (flat format)
  isError?: boolean
}

// Agent state info for UI
export interface AgentStateInfo {
  state: AgentState
  toolName?: string
  updatedAt: number
}

// Type guards
function isSetFrame(frame: TymbalFrame): frame is TymbalFrame & { t: string; v: MessageValue } {
  return 'v' in frame && frame.v !== null && 't' in frame
}

function isAppendFrame(frame: TymbalFrame): frame is TymbalFrame & { a: string } {
  return 'a' in frame
}

function isStartFrame(frame: TymbalFrame): boolean {
  // StartFrame: has 'i' but no 'a', no 'v', not a request, not an error
  // May or may not have 'm' (metadata)
  return 'i' in frame && !('a' in frame) && !('v' in frame) && !('request' in frame) && !('error' in frame)
}

function isResetFrame(frame: TymbalFrame): frame is TymbalFrame & { v: null } {
  return 'v' in frame && frame.v === null
}

function isErrorFrame(frame: TymbalFrame): frame is TymbalFrame & { error: string } {
  return 'error' in frame
}

interface SyncInfo {
  /** Whether there are more messages older than what we've loaded */
  hasMore: boolean
  /** ID of the oldest message loaded (use as 'before' cursor for pagination) */
  oldestId?: string
}

interface UseTymbalConnectionOptions {
  channelId: string | null
  onMessage: (message: Message) => void
  onMessageUpdate: (id: string, content: string) => void
  onAgentStateChange?: (agent: string, state: AgentStateInfo) => void
  onArtifactEvent?: (event: ArtifactEvent) => void
  onRosterEvent?: (event: RosterEvent) => void
  /** Called when sync completes (useful for clearing loading states) */
  onSyncComplete?: (syncInfo?: SyncInfo) => void
  currentUser?: string
  /** Pre-fetched WebSocket auth token (avoids re-fetch on every channel switch) */
  wsToken?: string
  /** Timestamp of newest cached message - use for incremental sync */
  newestCachedTimestamp?: string
}

interface PendingMessage {
  metadata: MessageMetadata
  buffer: string
  startedAt: number
}

/**
 * Hook for managing Tymbal WebSocket connection to a channel.
 * Handles frame parsing, streaming state, and reconnection.
 */
export function useTymbalConnection({
  channelId,
  onMessage,
  onMessageUpdate,
  onAgentStateChange,
  onArtifactEvent,
  onRosterEvent,
  onSyncComplete,
  currentUser = 'user',
  wsToken: providedWsToken,
  newestCachedTimestamp,
}: UseTymbalConnectionOptions) {
  const [connected, setConnected] = useState(false)
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false)
  const [agentStates, setAgentStates] = useState<Map<string, AgentStateInfo>>(new Map())
  const [hasMoreMessages, setHasMoreMessages] = useState(true)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const pendingMessages = useRef<Map<string, PendingMessage>>(new Map())
  const agentOutputBuffers = useRef<Map<string, { buffer: string; messageId: string }>>(new Map())
  const lastTimestampRef = useRef<string | null>(null)
  const oldestMessageIdRef = useRef<string | null>(null)

  // Parse a single frame from JSON string
  const parseFrame = useCallback((line: string): TymbalFrame | null => {
    try {
      return JSON.parse(line) as TymbalFrame
    } catch {
      console.warn('Failed to parse frame:', line)
      return null
    }
  }, [])

  // Fallback ref for channelId (used if server doesn't send 'c' field)
  const channelIdRef = useRef<string | null>(channelId)
  channelIdRef.current = channelId

  // Process incoming Tymbal frames
  // Server includes channelId ('c' field) on each frame for reliable routing
  const processFrame = useCallback(
    (frame: TymbalFrame) => {
      // Read channel from frame (server-authoritative), fallback to ref for backwards compatibility
      const currentChannelId = frame.c || channelIdRef.current

      // Sync response frame - signals end of message history sync
      if ('sync' in frame) {
        const syncFrame = frame as { sync: string; hasMore?: boolean; oldestId?: string }
        console.log(`[ChannelSwitch] Sync complete at ${performance.now().toFixed(2)}ms, hasMore=${syncFrame.hasMore}, oldestId=${syncFrame.oldestId}`)

        // Update pagination state
        if (syncFrame.hasMore !== undefined) {
          setHasMoreMessages(syncFrame.hasMore)
        }
        if (syncFrame.oldestId) {
          // Only update if this is older than what we have (or first load)
          if (!oldestMessageIdRef.current || syncFrame.oldestId < oldestMessageIdRef.current) {
            oldestMessageIdRef.current = syncFrame.oldestId
          }
        }
        setIsLoadingOlder(false)

        onSyncComplete?.({ hasMore: syncFrame.hasMore ?? true, oldestId: syncFrame.oldestId })
        return
      }

      // Start frame - initialize pending message for streaming
      // Don't emit message yet - wait for first content to avoid empty bubbles
      if (isStartFrame(frame)) {
        // Start frames may have metadata (m) or be bare
        const metadata: MessageMetadata = frame.m || { type: 'agent' as MessageType, sender: 'unknown', senderType: 'agent' as const }
        pendingMessages.current.set(frame.i, {
          metadata,
          buffer: '',
          startedAt: Date.now(),
        })
        return
      }

      // Append frame - accumulate content for streaming
      if (isAppendFrame(frame)) {
        const pending = pendingMessages.current.get(frame.i)
        if (pending) {
          const isFirstContent = pending.buffer === ''
          pending.buffer += frame.a

          if (isFirstContent) {
            // First content chunk - now emit the message with initial content
            onMessage({
              id: frame.i,
              channelId: currentChannelId!,
              type: pending.metadata.type,
              content: pending.buffer,
              sender: pending.metadata.sender,
              senderType: pending.metadata.senderType,
              timestamp: new Date().toISOString(),
            })
          } else {
            // Subsequent chunks - emit update for progressive rendering
            onMessageUpdate(frame.i, pending.buffer)
          }
        }
        return
      }

      // Set frame - complete message (most common from server)
      if (isSetFrame(frame)) {
        pendingMessages.current.delete(frame.i)
        lastTimestampRef.current = frame.t

        const value = frame.v

        // Handle agent_state frames - lifecycle updates
        if (value.type === 'agent_state' && value.state) {
          const agentKey = `${currentChannelId}:${value.sender}`
          const stateInfo: AgentStateInfo = {
            state: value.state,
            toolName: value.toolName,
            updatedAt: Date.now(),
          }

          setAgentStates(prev => {
            const next = new Map(prev)
            if (value.state === 'stopped' || value.state === 'idle') {
              // Clear agent state when done or idle
              next.delete(agentKey)
            } else {
              next.set(agentKey, stateInfo)
            }
            return next
          })

          onAgentStateChange?.(value.sender, stateInfo)

          // If transitioning to idle or stopped, mark response as complete
          if (value.state === 'idle' || value.state === 'stopped') {
            setIsWaitingForResponse(false)
            const bufferKey = `${currentChannelId}:${value.sender}`
            const buffer = agentOutputBuffers.current.get(bufferKey)
            if (buffer && buffer.buffer) {
              onMessageUpdate(buffer.messageId, buffer.buffer)
              agentOutputBuffers.current.delete(bufferKey)
            }
          }
          return
        }

        // Handle agent_output frames - streaming agent responses
        if (value.type === 'agent_output' && value.agentOutput) {
          const agentKey = `${currentChannelId}:${value.sender}`
          const output = value.agentOutput

          if (output.type === 'text') {
            // Accumulate text output
            let buffer = agentOutputBuffers.current.get(agentKey)
            const isFirstChunk = !buffer

            if (!buffer) {
              // First chunk - create buffer but defer message emission
              buffer = { buffer: '', messageId: frame.i }
              agentOutputBuffers.current.set(agentKey, buffer)
            }

            buffer.buffer += output.content

            if (isFirstChunk) {
              // Emit message with initial content (not empty)
              onMessage({
                id: frame.i,
                channelId: currentChannelId!,
                type: 'agent',
                content: buffer.buffer,
                sender: value.sender,
                senderType: 'agent',
                timestamp: frame.t,
              })
            } else {
              // Subsequent chunks - update existing message
              onMessageUpdate(buffer.messageId, buffer.buffer)
            }
          } else if (output.type === 'tool_use') {
            // Tool invocation - emit as tool_call message with all tool fields
            onMessage({
              id: frame.i,
              channelId: currentChannelId!,
              type: 'tool_call',
              content: '',
              sender: value.sender,
              senderType: 'agent',
              timestamp: frame.t,
              toolCallId: output.toolCallId,
              toolName: output.toolName,
              toolArgs: output.arguments,
            })
          } else if (output.type === 'tool_result') {
            // Tool result - emit as tool_result message with all result fields
            const isError = output.status === 'error'
            onMessage({
              id: frame.i,
              channelId: currentChannelId!,
              type: 'tool_result',
              content: '',
              sender: value.sender,
              senderType: 'agent',
              timestamp: frame.t,
              toolResultCallId: output.toolCallId,
              toolResultStatus: isError ? 'error' : 'success',
              toolResultOutput: output.output ?? output.content,
              toolResultError: isError ? output.error : undefined,
            })
          }
          return
        }

        // Handle artifact events from board operations
        if (value.type === 'artifact' && onArtifactEvent) {
          const artifactValue = value as unknown as { action: string; artifact: ArtifactEvent['artifact'] }
          if (artifactValue.action && artifactValue.artifact) {
            onArtifactEvent({
              action: artifactValue.action as ArtifactEvent['action'],
              artifact: artifactValue.artifact,
            })
          }
          return
        }

        // Handle roster events (agent_joined, agent_dismissed)
        if (value.type === 'roster' && onRosterEvent) {
          const rosterValue = value as unknown as { action: string; agent: RosterEvent['agent'] }
          if (rosterValue.action && rosterValue.agent) {
            onRosterEvent({
              action: rosterValue.action as RosterEvent['action'],
              agent: rosterValue.agent,
            })
          }
          return
        }

        // Handle tool_call frames - tool data is flat on value
        if (value.type === 'tool_call') {
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: 'tool_call',
            content: '',
            sender: value.sender || 'agent',
            senderType: 'agent',
            timestamp: frame.t,
            toolCallId: value.toolCallId,
            toolName: value.name,
            toolArgs: value.args,
          })
          return
        }

        // Handle tool_result frames - result data is flat on value
        if (value.type === 'tool_result') {
          const isError = value.isError === true
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: 'tool_result',
            content: '',
            sender: value.sender || 'agent',
            senderType: 'agent',
            timestamp: frame.t,
            toolResultCallId: value.toolCallId,
            toolResultStatus: isError ? 'error' : 'success',
            toolResultOutput: value.content,
            toolResultError: isError ? value.content : undefined,
          })
          return
        }

        // Standard message handling - whitelist approach
        // Only render known renderable message types
        const renderableTypes = ['user', 'agent', 'error', 'status', 'attachment', 'structured_ask', 'idle', 'thinking']
        if (!renderableTypes.includes(value.type)) {
          // Render unrecognized types as error messages for visibility
          // This catches compliance issues (e.g., old 'assistant' type from stored data)
          console.error('[Tymbal] Unrecognized message type:', value.type, frame.i, value)
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: 'error',
            content: `Unrecognized message type: "${value.type}"\n\nRaw: ${JSON.stringify(value, null, 2)}`,
            sender: 'system',
            senderType: 'agent',
            timestamp: frame.t,
          })
          return
        }

        // Skip non-renderable types that we recognize but don't display
        if (value.type === 'idle' || value.type === 'thinking') {
          // idle: turn completion signal, thinking: internal traces - don't render as bubbles
          return
        }

        // Skip empty agent messages to avoid empty bubbles
        if (value.type === 'agent' && !value.content) {
          return
        }

        // Clear waiting state when we get an agent message
        if (value.senderType === 'agent' && value.type === 'agent') {
          setIsWaitingForResponse(false)
        }
        onMessage({
          id: frame.i,
          channelId: currentChannelId!,
          type: value.type,
          content: typeof value.content === 'string' ? value.content : '',
          sender: value.sender,
          senderType: value.senderType,
          timestamp: frame.t,
        })
        return
      }

      // Reset frame - delete message
      if (isResetFrame(frame)) {
        pendingMessages.current.delete(frame.i)
        // TODO: Emit delete event
        return
      }

      // Error frame
      if (isErrorFrame(frame)) {
        console.error('Tymbal error:', frame.error, frame.message)
        return
      }
    },
    [onMessage, onMessageUpdate, onArtifactEvent, onRosterEvent, onSyncComplete]
  )

  // Track current channel for the WebSocket
  const currentChannelRef = useRef<string | null>(null)
  // Track the desired channel (for onopen to read latest value)
  const desiredChannelRef = useRef<string | null>(channelId)

  // Track newest cached timestamp per channel for incremental sync
  const newestCachedTimestampRef = useRef<string | undefined>(newestCachedTimestamp)
  newestCachedTimestampRef.current = newestCachedTimestamp

  // Send sync request to switch/sync channel
  const sendSyncRequest = useCallback((targetChannelId: string) => {
    console.log(`[ChannelSwitch] sendSyncRequest called for ${targetChannelId}, newestCachedTimestamp=${newestCachedTimestampRef.current}`)
    const ws = wsRef.current
    if (!ws) {
      console.log(`[ChannelSwitch] sendSyncRequest: ws is null`)
      return
    }
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[ChannelSwitch] sendSyncRequest: ws not open, state=${ws.readyState}`)
      return
    }

    const syncRequest: Record<string, unknown> = {
      request: 'sync',
      channelId: targetChannelId,
    }
    // Use cached timestamp for incremental sync if available
    // newestCachedTimestampRef.current is computed for the target channel in App.tsx
    // If undefined, this is a new/uncached channel - fetch full history
    if (newestCachedTimestampRef.current) {
      syncRequest.since = newestCachedTimestampRef.current
      console.log(`[ChannelSwitch] Using cached timestamp for incremental sync: ${newestCachedTimestampRef.current}`)
    }
    // Note: lastTimestampRef is for live updates on same channel, not used for channel switches
    if (providedWsToken) {
      syncRequest.token = providedWsToken
    }
    console.log(`[ChannelSwitch] Sync request sent at ${performance.now().toFixed(2)}ms`, syncRequest)
    ws.send(JSON.stringify(syncRequest))
    currentChannelRef.current = targetChannelId
  }, [providedWsToken])

  // Request older messages (for infinite scroll)
  const requestOlderMessages = useCallback((limit = 25) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[Pagination] Cannot request older messages: WebSocket not ready')
      return
    }
    if (!channelId) {
      console.log('[Pagination] Cannot request older messages: no channel')
      return
    }
    if (!hasMoreMessages) {
      console.log('[Pagination] No more messages to load')
      return
    }
    if (isLoadingOlder) {
      console.log('[Pagination] Already loading older messages')
      return
    }
    if (!oldestMessageIdRef.current) {
      console.log('[Pagination] No oldest message ID yet')
      return
    }

    setIsLoadingOlder(true)
    const syncRequest: Record<string, unknown> = {
      request: 'sync',
      channelId,
      before: oldestMessageIdRef.current,
      limit,
    }
    if (providedWsToken) {
      syncRequest.token = providedWsToken
    }
    console.log('[Pagination] Requesting older messages:', syncRequest)
    ws.send(JSON.stringify(syncRequest))
  }, [channelId, hasMoreMessages, isLoadingOlder, providedWsToken])

  // Manage WebSocket connection and channel switching
  useLayoutEffect(() => {
    console.log(`[ChannelSwitch] Main effect: channelId=${channelId}, wsRef=${wsRef.current ? 'exists' : 'null'}`)

    // Update desired channel ref
    desiredChannelRef.current = channelId

    // Create WebSocket if we don't have one
    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      const wsUrlEnv = import.meta.env.VITE_WS_URL
      const isAwsWs = wsUrlEnv && (
        wsUrlEnv.includes('execute-api') ||
        (wsUrlEnv.startsWith('wss://') && !wsUrlEnv.includes('localhost'))
      )

      let wsUrl: string
      if (wsUrlEnv) {
        if (isAwsWs) {
          wsUrl = wsUrlEnv
        } else {
          wsUrl = `${wsUrlEnv}/stream`
        }
      } else {
        const wsBase = API_HOST.replace(/^http/, 'ws')
        wsUrl = `${wsBase}/stream`
      }

      console.log(`[ChannelSwitch] Creating WebSocket to ${wsUrl} at ${performance.now().toFixed(2)}ms`)
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        console.log(`[ChannelSwitch] WebSocket opened at ${performance.now().toFixed(2)}ms`)
        // Send sync for current desired channel
        const target = desiredChannelRef.current
        if (target) {
          console.log(`[ChannelSwitch] Sending initial sync for ${target}`)
          sendSyncRequest(target)
        }
      }

      ws.onclose = (event) => {
        console.log(`[ChannelSwitch] WebSocket closed: code=${event.code}`)
        setConnected(false)
      }

      ws.onerror = (error) => {
        console.error('[ChannelSwitch] WebSocket error:', error)
      }

      ws.onmessage = (event) => {
        const lines = (event.data as string).split('\n').filter(Boolean)
        for (const line of lines) {
          const frame = parseFrame(line)
          if (frame) {
            processFrame(frame)
          }
        }
      }
    }

    // If WebSocket exists and is open, send sync for channel change
    if (channelId && channelId !== currentChannelRef.current) {
      console.log(`[ChannelSwitch] Channel changed to ${channelId}`)
      lastTimestampRef.current = null // Reset for new channel
      oldestMessageIdRef.current = null // Reset pagination cursor
      setHasMoreMessages(true) // Assume more messages until proven otherwise

      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[ChannelSwitch] Sending sync for channel switch`)
        sendSyncRequest(channelId)
      } else {
        console.log(`[ChannelSwitch] WebSocket not ready (state=${ws?.readyState}), will sync on open`)
      }
    }

    if (!channelId) {
      currentChannelRef.current = null
    }
  }, [channelId, sendSyncRequest, processFrame, parseFrame])

  // Cleanup WebSocket on unmount only
  useEffect(() => {
    return () => {
      console.log('[ChannelSwitch] Cleanup: closing WebSocket')
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  // Send a user message via HTTP POST (server assigns ID)
  const sendMessage = useCallback(
    async (content: string) => {
      if (!channelId) {
        console.error('No channel selected')
        return
      }

      setIsWaitingForResponse(true)

      try {
        const response = await apiFetch(`/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content,
            sender: currentUser,
            senderType: 'user',
          }),
        })

        if (!response.ok) {
          setIsWaitingForResponse(false)
          throw new Error(`Failed to send message: ${response.status}`)
        }

        // Message will arrive via WebSocket - response state will be cleared when we get a reply
      } catch (error) {
        console.error('Failed to send message:', error)
        setIsWaitingForResponse(false)
      }
    },
    [channelId, currentUser]
  )

  return {
    connected,
    isWaitingForResponse,
    sendMessage,
    agentStates,
    // Pagination
    hasMoreMessages,
    isLoadingOlder,
    requestOlderMessages,
  }
}

export type { SyncInfo }
