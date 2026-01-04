export interface ChannelMetadata {
  tagline?: string
  mission?: string
  [key: string]: unknown
}

export interface Channel {
  name: string
  createdAt: string
  lastActivity?: string
  archived?: boolean
  metadata?: ChannelMetadata
}

export interface Message {
  id: string
  type: 'message'
  channel: string
  sender: string
  timestamp: string
  content: string
}

// Structured Ask types
export interface StructuredAskFieldOption {
  value: string
  label: string
}

export interface SummonRequestAgent {
  callsign: string
  definitionSlug: string
  purpose: string
}

export interface StructuredAskField {
  id: string
  label: string
  description?: string
  type: 'radio' | 'checkbox' | 'select' | 'text' | 'textarea' | 'summon_request'
  options?: StructuredAskFieldOption[]
  agents?: SummonRequestAgent[]  // For summon_request fields
  required?: boolean
  placeholder?: string
}

export interface StructuredAskFormData {
  prompt: string
  fields: StructuredAskField[]
  to: string[]
  submitLabel?: string
}

export interface StructuredAskMessage {
  id: string
  type: 'structured_ask'
  channel: string
  sender: string
  timestamp: string
  content: string
  formData: StructuredAskFormData
  formState: 'pending' | 'submitted'
  response?: Record<string, string | string[]>
  respondedBy?: string
  respondedAt?: string
}

export type AnyMessage = Message | StructuredAskMessage

export interface Participant {
  sender: string
  connectedAt: number
  status?: string
}

export interface UserConfig {
  name: string
  createdAt: string
}

export type AgentState = 'starting' | 'idle' | 'thinking' | 'tool_running' | 'stopped' | 'error'

export interface Agent {
  name: string
  channel: string
  engine: string
  sessionId?: string
  workdir?: string
  state: AgentState
  status?: string
  startedAt: string
  lastActivity: string
  error?: string
  pendingMessages?: number
}

export interface AgentOutput {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'system' | 'reasoning'
  timestamp: string
  content: string
  toolName?: string
  toolInput?: unknown
}

// Artifact types for the Board
export type ArtifactStatus = 'draft' | 'published' | 'archived'
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked'
export type Status = ArtifactStatus | TaskStatus

export interface Artifact {
  slug: string
  channel: string
  path: string
  title?: string
  tldr: string
  type: string // 'doc' | 'task' | 'decision' | 'code' | 'system.mcp' | 'system.agent'
  content: string
  contentType?: string
  encoding?: string // 'file' for binary assets stored on filesystem
  refs: string[]
  status: Status
  parentSlug?: string
  orderKey: string
  labels?: string[]
  assignees?: string[]
  props?: Record<string, unknown> // Type-specific props (e.g., system.mcp, system.agent)
  createdBy: string
  createdAt: string
  updatedBy?: string
  updatedAt?: string
  version: number
}

export interface ArtifactSummary {
  slug: string
  path: string
  type: string
  title: string | null
  status: Status
  tldr: string
  assignees?: string[]
  parentSlug: string | null
  orderKey: string
  encoding?: string | null  // 'file' for binary assets
  contentType?: string | null
}

export interface ArtifactVersion {
  version: string
  message?: string
  createdBy: string
  createdAt: string
}

export interface ArtifactEvent {
  action: 'created' | 'updated' | 'archived'
  artifact: Artifact
}

export interface ArtifactVersionEvent {
  slug: string
  version: string
  message?: string
  mentions: string[]
}
