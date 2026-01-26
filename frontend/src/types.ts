// Core types for CAST frontend
// Standalone - no external dependencies

export interface Channel {
  id: string
  name: string
  createdAt: string
  metadata?: {
    tagline?: string
    mission?: string
  }
  archived?: boolean
}

export interface Agent {
  id: string
  name: string
  description: string
}

export interface Thread {
  id: string
  agentId: string
  agentName: string
  createdAt?: string
  lastActiveAt?: string
}

export interface Message {
  id: string
  channelId: string
  type: MessageType
  content: string | Record<string, unknown>
  sender: string
  senderType: 'user' | 'agent' | 'system'
  timestamp: string
  // For tool_call messages
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  // For tool_result messages
  toolResultCallId?: string
  toolResultStatus?: 'success' | 'error'
  toolResultOutput?: unknown
  toolResultError?: string
  // For structured_ask messages
  formData?: StructuredAskFormData
  formState?: StructuredAskFormState
  response?: Record<string, unknown>
  respondedBy?: string
  respondedAt?: string
  dismissedBy?: string
  dismissedAt?: string
  // DB-level state for stateful messages (structured_ask: pending, completed, dismissed)
  state?: string
  // Asset artifact slugs attached to this message
  attachmentSlugs?: string[]
  // For attachment type messages (content is an object)
  attachmentData?: AttachmentMessageContent
  // Method used to send the message (e.g., 'send_message' for intentional agent messages)
  method?: string
}

/**
 * Content structure for attachment type messages.
 * When type='attachment', the content field contains this structure.
 */
export interface AttachmentMessageContent {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
  url: string
  title?: string
  description?: string
}

/**
 * A file attachment uploaded to a channel and linked to a message.
 */
export interface Attachment {
  /** Unique attachment identifier (ULID) */
  id: string
  /** Channel this attachment belongs to */
  channelId: string
  /** Message this attachment is linked to */
  messageId?: string
  /** Original filename */
  filename: string
  /** MIME type of the file */
  mimeType: string
  /** File size in bytes */
  size: number
  /** URL to access the file */
  url: string
  /** Who uploaded this attachment */
  uploadedBy: string
  /** ISO timestamp when uploaded */
  uploadedAt: string
}

export type MessageType =
  | 'user'
  | 'agent'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'error'
  | 'idle'
  | 'agent_state'
  | 'agent_output'
  | 'artifact'
  | 'roster'
  | 'structured_ask'
  | 'attachment'
  | 'event'

// Tymbal frame types (wire format)
export type TymbalFrame =
  | StartFrame
  | AppendFrame
  | SetFrame
  | ResetFrame
  | SyncRequest
  | ErrorFrame

export interface StartFrame {
  i: string // ULID
  m: MessageMetadata
}

export interface AppendFrame {
  i: string // ULID
  a: string // Text to append
}

export interface SetFrame {
  i: string // ULID
  t: string // Timestamp (ISO 8601)
  v: MessageValue
}

export interface ResetFrame {
  i: string // ULID
  t: string // Timestamp
  v: null
}

export interface SyncRequest {
  request: 'sync'
  since?: string
}

export interface ErrorFrame {
  error: string
  message: string
}

export interface MessageMetadata {
  type: MessageType
  sender: string
  senderType: 'user' | 'agent' | 'system'
  // For tool_call
  toolCallId?: string
  name?: string
}

export interface MessageValue {
  type: MessageType
  content?: string
  sender: string
  senderType: 'user' | 'agent' | 'system'
  // For tool_call
  toolCallId?: string
  name?: string
  arguments?: Record<string, unknown>
  // For tool_result
  status?: 'success' | 'error'
  output?: unknown
  error?: string
}

/**
 * Artifact interface for frontend use.
 *
 * ⚠️  SYNC WARNING: This interface must stay aligned with StoredArtifact in
 *     backend/packages/core/src/types.ts. If you modify fields here, check
 *     if the backend type needs updating too.
 *
 * NOTE: This is the user-facing shape. Backend's StoredArtifact has additional
 * computed fields (path, refs) that are not included here since they're derived.
 */
export interface Artifact {
  id: string
  slug: string
  channelId: string
  type: ArtifactType
  title?: string
  tldr?: string
  content: string
  parentSlug?: string
  orderKey: string
  status: ArtifactStatus
  props?: Record<string, unknown>
  version: number
  createdAt: string
  updatedAt?: string
  createdBy: string
  assignees?: string[]
  labels?: string[]
  /** Binary asset MIME type (e.g., 'image/png') for icon detection */
  contentType?: string | null
  /** Named version checkpoints (e.g., ['v1.0', 'v2.0']) */
  versions?: string[]
  /** Secrets metadata (values never exposed, only setAt/expiresAt) */
  secrets?: Record<string, { setAt: string; expiresAt?: string }>
}

/** A named version snapshot of an artifact */
export interface ArtifactVersion {
  id: string
  artifactId: string
  versionName: string
  message?: string
  content: string
  tldr?: string
  createdBy: string
  createdAt: string
}

/**
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactType in backend/packages/core/src/types.ts
 */
export type ArtifactType =
  | 'doc'
  | 'folder'
  | 'task'
  | 'code'
  | 'decision'
  | 'knowledgebase'
  | 'asset'
  | 'system.mcp'
  | 'system.agent'
  | 'system.environment'
  | 'system.focus'
  | 'system.playbook'
  | 'system.app'

/**
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactStatus in backend/packages/core/src/types.ts
 *
 * Status model:
 * - Tasks: pending → in_progress → done / blocked
 * - Everything else: draft / active / archived
 */
export type ArtifactStatus =
  | 'draft'
  | 'active'
  | 'archived'
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'published' // Legacy - use 'active' for new artifacts

// Agent lifecycle states
export type AgentState =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'tool_use'
  | 'stopped'
  | 'error'
  // Roster lifecycle states (broadcast from backend)
  | 'connecting'
  | 'online'
  | 'offline'
  | 'paused'

// Agent output types for streaming
export interface AgentOutput {
  type: 'text' | 'tool_use' | 'tool_result'
  content: string
  toolName?: string
  toolCallId?: string
  arguments?: Record<string, unknown>
  status?: 'success' | 'error'
  output?: unknown
  error?: string
}

// Tool progress types for SDK integration
export interface ToolProgressEvent {
  type: 'tool_progress'
  toolUseId: string
  toolName: string
  elapsedSeconds: number
  parentToolUseId: string | null
}

export interface SDKCompleteEvent {
  type: 'sdk_complete'
  subtype: 'success'
  durationMs: number
  numTurns: number
  totalCostUsd: number
  result: string
}

export interface ToolActivity {
  id: string              // toolUseId
  name: string            // "Read", "Bash", "Edit"
  args?: string           // File path, command, etc.
  status: 'running' | 'complete' | 'error'
  elapsedSeconds: number
  output?: string         // Result or error message
  expanded: boolean
}

export interface AgentActivity {
  state: 'idle' | 'thinking' | 'tool_running'
  tools: Map<string, ToolActivity>  // keyed by toolUseId
  expandedTools: Set<string>
  turnSummary?: { durationMs: number; numTurns: number }
}

/**
 * Artifact tree node for board display.
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactTreeNode in backend/packages/core/src/types.ts
 */
export interface ArtifactTreeNode {
  slug: string
  path: string
  type: ArtifactType
  title?: string
  status: ArtifactStatus
  assignees: string[]
  /** Lexicographic sort key for ordering within parent */
  orderKey: string
  /** Binary asset MIME type (e.g., 'image/png') for icon detection */
  contentType?: string | null
  children?: ArtifactTreeNode[]
}

// =============================================================================
// Structured Ask Types
// =============================================================================

interface BaseField {
  name: string           // Field identifier (used as key in response)
  label: string          // Display label
  required?: boolean
}

export interface RadioField extends BaseField {
  type: 'radio'
  options: string[]
  default?: string
}

export interface CheckboxField extends BaseField {
  type: 'checkbox'
  options: string[]
  default?: string[]
}

export interface SelectField extends BaseField {
  type: 'select'
  options: string[]
  default?: string
}

export interface TextField extends BaseField {
  type: 'text'
  placeholder?: string
  default?: string
}

export interface TextareaField extends BaseField {
  type: 'textarea'
  placeholder?: string
  default?: string
}

export interface SummonRequestAgent {
  callsign: string
  definitionSlug: string
  purpose: string
}

/** Response value for a summon_request field - includes runtime selection */
export interface SummonRequestResponse {
  callsign: string
  runtimeId: string | null
}

export interface SummonRequestField extends BaseField {
  type: 'summon_request'
  agents: SummonRequestAgent[]
}

export interface SecretField extends BaseField {
  type: 'secret'
  placeholder?: string
  default?: string
  // Target for where to store the secret
  targetChannel: string  // channel name or ID
  targetSlug: string     // artifact slug (system.mcp or system.environment)
  targetKey: string      // secret key name (e.g., "OPENAI_API_KEY")
}

export type StructuredAskField =
  | RadioField
  | CheckboxField
  | SelectField
  | TextField
  | TextareaField
  | SummonRequestField
  | SecretField

export interface StructuredAskFormData {
  prompt: string
  fields: StructuredAskField[]
  submitLabel?: string
  cancelLabel?: string
}

export type StructuredAskFormState = 'pending' | 'submitted' | 'dismissed'

export interface StructuredAskMessage {
  id: string
  type: 'structured_ask'
  channelId: string
  sender: string
  timestamp: string
  content: string          // The prompt text (duplicated from formData for display)
  formData: StructuredAskFormData
  formState: StructuredAskFormState
  response?: Record<string, string | string[] | SummonRequestResponse[]>
  respondedBy?: string
  respondedAt?: string
  dismissedBy?: string
  dismissedAt?: string
}

export function isStructuredAskMessage(value: unknown): value is StructuredAskMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as StructuredAskMessage).type === 'structured_ask' &&
    typeof (value as StructuredAskMessage).id === 'string' &&
    typeof (value as StructuredAskMessage).channelId === 'string' &&
    typeof (value as StructuredAskMessage).formData === 'object'
  )
}

export function isStructuredAskField(value: unknown): value is StructuredAskField {
  if (typeof value !== 'object' || value === null) return false
  const field = value as StructuredAskField
  return (
    typeof field.name === 'string' &&
    typeof field.label === 'string' &&
    ['radio', 'checkbox', 'select', 'text', 'textarea', 'summon_request'].includes(field.type)
  )
}
