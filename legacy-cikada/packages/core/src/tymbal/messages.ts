/**
 * Tymbal Protocol - Message Types
 *
 * Semantic layer defining the message types that flow over Tymbal frames.
 * Each message type has a specific structure and purpose.
 *
 * @see /spec/tymbal/messages.md for the full specification
 */

// =============================================================================
// Message Type Enum
// =============================================================================

export type MessageType =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'error'
  | 'agent_message'
  | 'agent_complete';

// =============================================================================
// Message Value Types
// =============================================================================

/**
 * User message - human input.
 */
export interface UserMessage {
  type: 'user';
  content: string;
  sender: string;
  senderType: 'user';
}

/**
 * Assistant message - agent response (streamable).
 */
export interface AssistantMessage {
  type: 'assistant';
  content: string;
  sender: string;
  senderType: 'agent';
}

/**
 * Tool call - agent requests tool execution.
 */
export interface ToolCallMessage {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  sender: string;
  senderType: 'agent';
}

/**
 * Tool result - outcome of tool execution.
 */
export interface ToolResultMessage {
  type: 'tool_result';
  toolCallId: string;
  content: unknown;
  status: 'success' | 'error';
  sender: string;
  senderType: 'agent' | 'user';
}

/**
 * Thinking message - agent reasoning (optional visibility).
 */
export interface ThinkingMessage {
  type: 'thinking';
  content: string;
  sender: string;
  senderType: 'agent';
}

/**
 * Status message - transient UI hints.
 */
export interface StatusMessage {
  type: 'status';
  status: string;
  sender: string;
  senderType: 'agent';
}

/**
 * Error message - semantic error (not protocol-level).
 */
export interface ErrorMessage {
  type: 'error';
  content: string;
  code: string;
  recoverable: boolean;
  sender: string;
  senderType: 'agent';
}

/**
 * Agent message - inter-agent communication.
 */
export interface AgentMessageMessage {
  type: 'agent_message';
  senderId: string;
  payload: unknown;
  replyTo?: string;
  sender: string;
  senderType: 'agent';
}

/**
 * Agent complete - sub-agent finished with result.
 */
export interface AgentCompleteMessage {
  type: 'agent_complete';
  agentId: string;
  result: unknown;
  sender: string;
  senderType: 'agent';
}

// =============================================================================
// Union Type
// =============================================================================

export type MessageValue =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage
  | ThinkingMessage
  | StatusMessage
  | ErrorMessage
  | AgentMessageMessage
  | AgentCompleteMessage;

// =============================================================================
// Type Guards
// =============================================================================

export function isUserMessage(msg: MessageValue): msg is UserMessage {
  return msg.type === 'user';
}

export function isAssistantMessage(msg: MessageValue): msg is AssistantMessage {
  return msg.type === 'assistant';
}

export function isToolCallMessage(msg: MessageValue): msg is ToolCallMessage {
  return msg.type === 'tool_call';
}

export function isToolResultMessage(msg: MessageValue): msg is ToolResultMessage {
  return msg.type === 'tool_result';
}

export function isThinkingMessage(msg: MessageValue): msg is ThinkingMessage {
  return msg.type === 'thinking';
}

export function isStatusMessage(msg: MessageValue): msg is StatusMessage {
  return msg.type === 'status';
}

export function isErrorMessage(msg: MessageValue): msg is ErrorMessage {
  return msg.type === 'error';
}

export function isAgentMessageMessage(msg: MessageValue): msg is AgentMessageMessage {
  return msg.type === 'agent_message';
}

export function isAgentCompleteMessage(msg: MessageValue): msg is AgentCompleteMessage {
  return msg.type === 'agent_complete';
}
