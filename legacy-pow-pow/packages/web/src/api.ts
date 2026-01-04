import { Channel, ChannelMetadata, Message, Participant, Agent, AgentOutput, Artifact, ArtifactSummary, ArtifactEvent, ArtifactVersionEvent, ArtifactVersion, StructuredAskMessage } from './types'

const BASE_URL = import.meta.env.VITE_POWPOW_URL || ''

export async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch(BASE_URL + '/api/channels')
  if (!res.ok) throw new Error('Failed to fetch channels')
  return res.json()
}

export async function createChannel(name: string, metadata?: Partial<ChannelMetadata>, focus?: string): Promise<Channel> {
  const body: { name: string; metadata?: Partial<ChannelMetadata>; focus?: string } = { name }
  if (metadata) body.metadata = metadata
  if (focus) body.focus = focus

  const res = await fetch(BASE_URL + '/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create channel' }))
    throw new Error(err.error || 'Failed to create channel')
  }
  return res.json()
}

export async function fetchMessages(channel: string, limit = 100, before?: string): Promise<Message[]> {
  let url = BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/messages?limit=' + limit
  if (before) url += '&before=' + encodeURIComponent(before)
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch messages')
  return res.json()
}

export async function fetchParticipants(channel: string): Promise<Participant[]> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/participants')
  if (!res.ok) throw new Error('Failed to fetch participants')
  return res.json()
}

export async function sendMessage(channel: string, sender: string, content: string): Promise<Message> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, content }),
  })
  if (!res.ok) throw new Error('Failed to send message')
  return res.json()
}

export async function submitStructuredAsk(
  channel: string,
  messageId: string,
  respondedBy: string,
  response: Record<string, string | string[]>
): Promise<StructuredAskMessage> {
  const res = await fetch(
    BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/structured-ask/' + encodeURIComponent(messageId) + '/submit',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respondedBy, response }),
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to submit response' }))
    throw new Error(err.error || 'Failed to submit response')
  }
  const data = await res.json()
  return data.message
}

export function subscribeToChannel(
  channel: string,
  sender: string,
  onMessages: (messages: Message[]) => void
): () => void {
  const url = BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/stream?sender=' + encodeURIComponent(sender)
  const eventSource = new EventSource(url)

  eventSource.addEventListener('messages', (event) => {
    try {
      const messages: Message[] = JSON.parse(event.data)
      onMessages(messages)
    } catch {}
  })

  eventSource.onerror = () => {
    // Will auto-reconnect
  }

  return () => eventSource.close()
}

export async function spawnAgent(channel: string, name: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(BASE_URL + '/api/agents/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, name }),
  })
  return res.json()
}

export async function kickAgent(channel: string, name: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(BASE_URL + '/api/agents/kick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, name }),
  })
  return res.json()
}

export async function fetchAgents(channel?: string): Promise<Agent[]> {
  const url = channel
    ? BASE_URL + '/api/agents?channel=' + encodeURIComponent(channel)
    : BASE_URL + '/api/agents'
  const res = await fetch(url)
  return res.json()
}

export async function fetchAgent(channel: string, name: string): Promise<Agent | null> {
  const res = await fetch(BASE_URL + '/api/agents/' + encodeURIComponent(channel) + '/' + encodeURIComponent(name))
  if (!res.ok) return null
  return res.json()
}

export async function fetchAgentOutput(channel: string, name: string, limit = 50): Promise<AgentOutput[]> {
  const res = await fetch(
    BASE_URL + '/api/agents/' + encodeURIComponent(channel) + '/' + encodeURIComponent(name) + '/output?limit=' + limit
  )
  if (!res.ok) return []
  return res.json()
}

export async function fetchAgentWorkspaces(channel?: string): Promise<{ channel: string; name: string }[]> {
  const url = channel
    ? BASE_URL + '/api/agents/workspaces?channel=' + encodeURIComponent(channel)
    : BASE_URL + '/api/agents/workspaces'
  const res = await fetch(url)
  if (!res.ok) return []
  return res.json()
}

export async function deleteAgentWorkspace(channel: string, name: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(BASE_URL + '/api/agents/workspace', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, name }),
  })
  return res.json()
}

export async function kickAllAgents(channel: string): Promise<{ kicked: string[]; message: string }> {
  const agents = await fetchAgents(channel)
  const kicked: string[] = []
  for (const agent of agents) {
    const result = await kickAgent(channel, agent.name)
    if (result.success) kicked.push(agent.name)
  }
  return {
    kicked,
    message: kicked.length > 0 ? `Kicked ${kicked.join(', ')} from #${channel}` : 'No agents to kick'
  }
}

export async function archiveChannel(channel: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/archive', {
    method: 'POST',
  })
  return res.json()
}

export async function unarchiveChannel(channel: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/unarchive', {
    method: 'POST',
  })
  return res.json()
}

export async function fetchChannelMetadata(channel: string): Promise<ChannelMetadata> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/metadata')
  if (!res.ok) return {}
  return res.json()
}

export async function updateChannelMetadata(channel: string, metadata: Partial<ChannelMetadata>): Promise<{ success: boolean; metadata?: ChannelMetadata; error?: string }> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/metadata', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  })
  return res.json()
}

// Settings API - Backends

export interface EngineCapabilities {
  supportsMcp: boolean
  supportsTools: boolean
  supportsVision: boolean
  supportsMidTurnMessages?: boolean
  supportsInterruption?: boolean
  exposesReasoning?: boolean
  supportsSessionResume?: boolean
}

export interface BackendInfo {
  name: string
  isBuiltIn: boolean
  capabilities: EngineCapabilities
}

export async function fetchBackends(): Promise<BackendInfo[]> {
  const res = await fetch(BASE_URL + '/api/backends')
  if (!res.ok) throw new Error('Failed to fetch backends')
  return res.json()
}

// OAuth API

// Backend returns these statuses; 'expiring_soon' is derived in UI from expiresAt
export type OAuthBackendStatus = 'disconnected' | 'connected' | 'expired'
// UI status includes derived 'expiring_soon' state
export type OAuthStatus = OAuthBackendStatus | 'expiring_soon'

export interface OAuthStatusResponse {
  status: OAuthBackendStatus
  expiresAt?: string // ISO timestamp
  scopes?: string[]  // granted scopes
}

export interface OAuthStartResponse {
  authorizationUrl: string
  state: string // for CSRF protection
}

// Derive UI status from backend response (adds 'expiring_soon' if within 24h)
export function deriveOAuthStatus(response: OAuthStatusResponse): OAuthStatus {
  if (response.status === 'connected' && response.expiresAt) {
    const expiresAt = new Date(response.expiresAt)
    const now = new Date()
    const hoursUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60)
    if (hoursUntilExpiry <= 24 && hoursUntilExpiry > 0) {
      return 'expiring_soon'
    }
  }
  return response.status
}

export async function fetchOAuthStatus(channel: string, mcpSlug: string): Promise<OAuthStatusResponse> {
  const res = await fetch(
    `${BASE_URL}/api/oauth/status?channel=${encodeURIComponent(channel)}&mcpSlug=${encodeURIComponent(mcpSlug)}`
  )
  if (!res.ok) {
    // Default to disconnected if endpoint not ready yet
    return { status: 'disconnected' }
  }
  return res.json()
}

export async function startOAuthFlow(channel: string, mcpSlug: string): Promise<OAuthStartResponse> {
  // For OAuth callback, we need the API server's origin, not the Vite dev server's
  // If BASE_URL is set (direct API access), use that; otherwise derive from current origin
  // replacing the Vite port (5173) with the API port (3232 for dev, 3131 for prod)
  let apiOrigin = window.location.origin
  if (BASE_URL) {
    // BASE_URL is the full API URL, extract origin
    try {
      apiOrigin = new URL(BASE_URL).origin
    } catch {
      // Keep window.location.origin as fallback
    }
  } else {
    // Vite proxy mode - replace port 5173 with API port
    // Dev uses 3232, but we can't know for sure, so use the standard dev port
    apiOrigin = apiOrigin.replace(':5173', ':3232')
  }

  const res = await fetch(
    `${BASE_URL}/api/oauth/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, mcpSlug, origin: apiOrigin }),
    }
  )
  if (!res.ok) throw new Error('Failed to start OAuth flow')
  return res.json()
}

export async function disconnectOAuth(channel: string, mcpSlug: string): Promise<void> {
  const res = await fetch(
    `${BASE_URL}/api/oauth/disconnect`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, mcpSlug }),
    }
  )
  if (!res.ok) throw new Error('Failed to disconnect OAuth')
}

// Channel Agents API

export interface ChannelAgent {
  channel: string
  name: string
  agentSlug?: string
  createdAt: string
  dismissed?: boolean
}

export async function fetchChannelAgents(channel: string): Promise<ChannelAgent[]> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/agents')
  if (!res.ok) return []
  return res.json()
}

export async function removeChannelAgent(channel: string, name: string): Promise<{ success: boolean }> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/agents/' + encodeURIComponent(name), {
    method: 'DELETE',
  })
  return res.json()
}

export async function startChannelAgents(channel: string): Promise<{ started: string[]; message: string }> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/start', {
    method: 'POST',
  })
  return res.json()
}

// Artifacts API

export async function fetchArtifacts(channel: string, options?: {
  type?: string
  status?: string
  parentSlug?: string
  search?: string
  regex?: string
  limit?: number
  offset?: number
}): Promise<ArtifactSummary[]> {
  const params = new URLSearchParams()
  if (options?.type) params.set('type', options.type)
  if (options?.status) params.set('status', options.status)
  if (options?.parentSlug) params.set('parentSlug', options.parentSlug)
  if (options?.search) params.set('search', options.search)
  if (options?.regex) params.set('regex', options.regex)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))

  const query = params.toString()
  const url = BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/artifacts' + (query ? '?' + query : '')
  const res = await fetch(url)
  if (!res.ok) return []
  return res.json()
}

export async function fetchArtifact(channel: string, slug: string): Promise<(Artifact & { versions: string[] }) | null> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/artifacts/' + encodeURIComponent(slug))
  if (!res.ok) return null
  return res.json()
}

export async function fetchArtifactVersions(channel: string, slug: string): Promise<ArtifactVersion[]> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/artifacts/' + encodeURIComponent(slug) + '/versions')
  if (!res.ok) return []
  return res.json()
}

export interface UpdateArtifactData {
  content?: string
  tldr?: string
  title?: string
  status?: string
  labels?: string[]
  assignees?: string[]
  parentSlug?: string
  orderKey?: string
  props?: Record<string, unknown>
  updatedBy: string
}

export async function updateArtifact(
  channel: string,
  slug: string,
  data: UpdateArtifactData,
  expectedVersion?: number
): Promise<Artifact | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (expectedVersion !== undefined) {
    headers['If-Match'] = String(expectedVersion)
  }
  const res = await fetch(
    BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/artifacts/' + encodeURIComponent(slug),
    { method: 'PUT', headers, body: JSON.stringify(data) }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Update failed' }))
    throw new Error(err.error || 'Update failed')
  }
  return res.json()
}

export interface CreateArtifactData {
  slug: string
  title?: string
  tldr: string
  type: string
  content: string
  contentType?: string
  status?: string
  parentSlug?: string
  orderKey?: string
  labels?: string[]
  assignees?: string[]
  createdBy: string
}

export async function createArtifact(
  channel: string,
  data: CreateArtifactData
): Promise<Artifact> {
  const res = await fetch(
    BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/artifacts',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Create failed' }))
    throw new Error(err.error || 'Create failed')
  }
  return res.json()
}

// Extended channel subscription with artifact events
export function subscribeToChannelWithArtifacts(
  channel: string,
  sender: string,
  callbacks: {
    onMessages?: (messages: Message[]) => void
    onArtifact?: (event: ArtifactEvent) => void
    onArtifactVersion?: (event: ArtifactVersionEvent) => void
  }
): () => void {
  const url = BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/stream?sender=' + encodeURIComponent(sender)
  const eventSource = new EventSource(url)

  if (callbacks.onMessages) {
    eventSource.addEventListener('messages', (event) => {
      try {
        const messages: Message[] = JSON.parse(event.data)
        callbacks.onMessages!(messages)
      } catch {}
    })
  }

  if (callbacks.onArtifact) {
    eventSource.addEventListener('artifact', (event) => {
      try {
        const artifactEvent: ArtifactEvent = JSON.parse(event.data)
        callbacks.onArtifact!(artifactEvent)
      } catch {}
    })
  }

  if (callbacks.onArtifactVersion) {
    eventSource.addEventListener('artifact_version', (event) => {
      try {
        const versionEvent: ArtifactVersionEvent = JSON.parse(event.data)
        callbacks.onArtifactVersion!(versionEvent)
      } catch {}
    })
  }

  eventSource.onerror = () => {
    // Will auto-reconnect
  }

  return () => eventSource.close()
}

// Agent Types API

export interface AgentType {
  slug: string
  name: string
  engine: string
}

export interface AgentTypesResponse {
  channel: string
  availableAgents: AgentType[]
  count: number
}

export async function fetchAgentTypes(channel: string): Promise<AgentTypesResponse> {
  const res = await fetch(BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/agent-types')
  if (!res.ok) {
    return { channel, availableAgents: [], count: 0 }
  }
  return res.json()
}

// File Upload API

export interface UploadResult {
  artifact: {
    slug: string
    channel: string
    path: string
    contentType: string
    size: number
    url: string
  }
}

export interface UploadError {
  error: string
  code?: string
}

export async function uploadFile(
  channel: string,
  file: File,
  options: {
    slug: string
    tldr?: string
    title?: string
    parentSlug?: string
  },
  onProgress?: (progress: number) => void
): Promise<UploadResult> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('slug', options.slug)
  if (options.tldr) formData.append('tldr', options.tldr)
  if (options.title) formData.append('title', options.title)
  if (options.parentSlug) formData.append('parentSlug', options.parentSlug)

  // Use XMLHttpRequest for progress tracking
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        const progress = Math.round((e.loaded / e.total) * 100)
        onProgress(progress)
      }
    })

    xhr.addEventListener('load', () => {
      try {
        const response = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(response)
        } else {
          const error = response as UploadError
          const err = new Error(error.error || 'Upload failed') as Error & { code?: string }
          if (error.code) err.code = error.code
          reject(err)
        }
      } catch {
        reject(new Error('Invalid response from server'))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    xhr.open('POST', BASE_URL + '/api/channels/' + encodeURIComponent(channel) + '/upload')
    xhr.send(formData)
  })
}

// Focus Types API

export interface FocusType {
  slug: string
  title: string
  tldr: string
}

export async function fetchFocusTypes(): Promise<FocusType[]> {
  const res = await fetch(BASE_URL + '/api/focus-types')
  if (!res.ok) {
    return []
  }
  return res.json()
}

// Central SSE Stream for Invalidation Events
// Use this instead of polling for channels and agents updates

export interface CentralSSEEvent {
  type: 'channels_changed' | 'agents_changed' | 'connected' | 'ping'
  channel?: string
  agent?: string
  timestamp: string
  clientId?: string
}

export interface CentralSSECallbacks {
  onChannelsChanged?: (channel?: string) => void
  onAgentsChanged?: (channel?: string, agent?: string) => void
  onConnected?: (clientId: string) => void
}

/**
 * Subscribe to the central SSE stream for real-time invalidation events.
 * This replaces polling for channel list and agent state updates.
 */
export function subscribeToCentralStream(callbacks: CentralSSECallbacks): () => void {
  const url = BASE_URL + '/api/stream'
  const eventSource = new EventSource(url)

  eventSource.addEventListener('connected', (event) => {
    try {
      const data = JSON.parse(event.data)
      callbacks.onConnected?.(data.clientId)
    } catch {}
  })

  eventSource.addEventListener('channels_changed', (event) => {
    try {
      const data: CentralSSEEvent = JSON.parse(event.data)
      callbacks.onChannelsChanged?.(data.channel)
    } catch {}
  })

  eventSource.addEventListener('agents_changed', (event) => {
    try {
      const data: CentralSSEEvent = JSON.parse(event.data)
      callbacks.onAgentsChanged?.(data.channel, data.agent)
    } catch {}
  })

  // Ignore ping events - they're just keepalives

  eventSource.onerror = () => {
    // Will auto-reconnect
  }

  return () => eventSource.close()
}
