import { useEffect, useRef, useState, useCallback } from 'react'
import type { Message, MessageType, AgentState, AgentOutput } from '../types'
import { apiFetch } from '../lib/api'

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

interface UseTymbalConnectionOptions {
  channelId: string | null
  onMessage: (message: Message) => void
  onMessageUpdate: (id: string, content: string) => void
  onAgentStateChange?: (agent: string, state: AgentStateInfo) => void
  onArtifactEvent?: (event: ArtifactEvent) => void
  onRosterEvent?: (event: RosterEvent) => void
  currentUser?: string
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
  currentUser = 'user',
}: UseTymbalConnectionOptions) {
  const [connected, setConnected] = useState(false)
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false)
  const [agentStates, setAgentStates] = useState<Map<string, AgentStateInfo>>(new Map())
  const wsRef = useRef<WebSocket | null>(null)
  const pendingMessages = useRef<Map<string, PendingMessage>>(new Map())
  const agentOutputBuffers = useRef<Map<string, { buffer: string; messageId: string }>>(new Map())
  const lastTimestampRef = useRef<string | null>(null)

  // Parse a single frame from JSON string
  const parseFrame = useCallback((line: string): TymbalFrame | null => {
    try {
      return JSON.parse(line) as TymbalFrame
    } catch {
      console.warn('Failed to parse frame:', line)
      return null
    }
  }, [])

  // Process incoming Tymbal frames
  const processFrame = useCallback(
    (frame: TymbalFrame) => {
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
              channelId: channelId!,
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
          const agentKey = `${channelId}:${value.sender}`
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
            const bufferKey = `${channelId}:${value.sender}`
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
          const agentKey = `${channelId}:${value.sender}`
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
                channelId: channelId!,
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
              channelId: channelId!,
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
              channelId: channelId!,
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
            channelId: channelId!,
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
            channelId: channelId!,
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
        const renderableTypes = ['user', 'agent', 'error', 'status', 'attachment', 'structured_ask']
        if (!renderableTypes.includes(value.type)) {
          // Log unknown types for debugging, don't render as bubbles
          console.debug('[Tymbal] Ignoring non-renderable message type:', value.type, frame.i)
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
          channelId: channelId!,
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
    [channelId, onMessage, onMessageUpdate, onArtifactEvent, onRosterEvent]
  )

  // Connect to WebSocket
  useEffect(() => {
    if (!channelId) {
      wsRef.current?.close()
      wsRef.current = null
      setConnected(false)
      return
    }

    // For AWS WebSocket connections, we need to pass a token for auth
    // because browsers don't send cookies cross-origin on WS connections.
    // Fetch the token first, then connect.
    const wsUrlEnv = import.meta.env.VITE_WS_URL
    // Detect AWS WebSocket - either default execute-api domain or custom domain (not localhost)
    const isAwsWs = wsUrlEnv && (
      wsUrlEnv.includes('execute-api') ||
      (wsUrlEnv.startsWith('wss://') && !wsUrlEnv.includes('localhost'))
    )

    // Async connection setup
    const connectWs = async () => {
      // Get wsToken for AWS connections
      let wsToken: string | undefined
      if (isAwsWs) {
        try {
          const response = await apiFetch('/auth/me')
          if (response.ok) {
            const data = await response.json()
            wsToken = data.wsToken
          }
        } catch (e) {
          console.error('Failed to get wsToken:', e)
          // Continue without token — sync will fail with auth error
        }
      }

      // Build WebSocket URL
      let wsUrl: string
      if (wsUrlEnv) {
        // Direct WebSocket URL provided (e.g., "wss://xxx.execute-api.us-east-1.amazonaws.com/stag")
        // AWS WebSocket API Gateway uses query params, not path segments
        if (isAwsWs) {
          wsUrl = `${wsUrlEnv}?channelId=${channelId}`
        } else {
          wsUrl = `${wsUrlEnv}/channels/${channelId}/stream`
        }
      } else {
        // Derive from API URL or use defaults
        const apiUrl = import.meta.env.VITE_API_URL
        let wsHost: string
        if (apiUrl) {
          // Extract host from VITE_API_URL (e.g., "http://localhost:3131" -> "localhost:3131")
          wsHost = apiUrl.replace(/^https?:\/\//, '')
        } else {
          wsHost = import.meta.env.DEV ? 'localhost:3233' : window.location.host
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        wsUrl = `${protocol}//${wsHost}/channels/${channelId}/stream`
      }

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        // Request sync to get message history
        // Include channelId and token for AWS auth (sync handler does auth, not connect)
        const syncRequest: Record<string, unknown> = {
          request: 'sync',
          channelId, // Required for channel sync
        }
        if (lastTimestampRef.current) {
          syncRequest.since = lastTimestampRef.current
        }
        if (wsToken) {
          syncRequest.token = wsToken // For AWS cross-origin auth
        }
        ws.send(JSON.stringify(syncRequest))
      }

      ws.onclose = () => {
        setConnected(false)
        // TODO: Implement reconnection with exponential backoff
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
        setConnected(false)
      }

      ws.onmessage = (event) => {
        // NDJSON - each line is a frame
        const lines = (event.data as string).split('\n').filter(Boolean)
        for (const line of lines) {
          const frame = parseFrame(line)
          if (frame) {
            processFrame(frame)
          }
        }
      }
    }

    connectWs()

    return () => {
      wsRef.current?.close()
      wsRef.current = null
      // Reset timestamp tracking so next channel gets full backlog
      lastTimestampRef.current = null
    }
  }, [channelId, processFrame])

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
  }
}
