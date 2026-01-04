import type { z } from "zod";

// =============================================================================
// Core Event Types
// =============================================================================

export type FlowEvent =
  // User messages
  | { type: "message"; content: string }
  // Inter-agent messages
  | { type: "agent:message"; id: string; senderId: string; payload: unknown; replyTo?: string }
  // Sub-agent lifecycle
  | { type: "agent:complete"; agentId: string; result: unknown }
  | { type: "agent:terminated"; agentId: string; result?: unknown }
  | { type: "agent:error"; agentId: string; error: Error }
  // Control signals
  | { type: "cancel" }      // agents only: interrupt current step
  | { type: "terminate" };  // shutdown requested

// =============================================================================
// Inter-Agent Messaging
// =============================================================================

/**
 * A message sent between agents.
 */
export interface AgentMessage {
  id: string;           // Unique message ID (ULID)
  senderId: string;     // Thread ID of sender
  payload: unknown;     // Message content (string or object)
  replyTo?: string;     // ID of message being replied to
  timestamp: string;    // ISO timestamp
}

/**
 * Result of sending a message.
 */
export interface SentMessage {
  id: string;         // Message ID
  threadId: string;   // Recipient thread
}

// =============================================================================
// LLM Types
// =============================================================================

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  result: unknown;
  isError?: boolean;
}

export interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface StepOptions {
  messages?: Message[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, ToolDefinition<any>>;
  maxTokens?: number;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string | ContentBlock[];
  cache_control?: { type: "ephemeral" };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

// =============================================================================
// Tool Definition
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<T = any> {
  description: string;
  parameters: z.ZodType<T>;
  execute: (args: T, ctx: Context) => Promise<unknown>;
}

/**
 * Helper to define a tool with proper type inference.
 */
export function defineTool<T>(tool: {
  description: string;
  parameters: z.ZodType<T>;
  execute: (args: T, ctx: Context) => Promise<unknown>;
}): ToolDefinition<T> {
  return tool;
}

// =============================================================================
// Message Handle (Tymbal abstraction)
// =============================================================================

export interface MessageHandle {
  id: string;
  stream(text: string): Promise<void>;
  set(value: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

// =============================================================================
// Agent Handle (for sub-agents)
// =============================================================================

export interface AgentHandle {
  id: string;          // Child's thread ID
  parentId: string;    // Parent's thread ID
  input: unknown;      // Input passed to spawn

  // Messaging
  send(payload: unknown): Promise<SentMessage>;

  // Control
  cancel(): Promise<void>;     // Agents only: interrupt current step
  terminate(): Promise<void>;  // Request shutdown
}

// =============================================================================
// Context
// =============================================================================

export interface Context {
  // Event stream (only available in onFlow)
  events: AsyncIterable<FlowEvent> & { next(): Promise<FlowEvent> };

  // LLM operations
  llm: {
    generate(content: string): Promise<GenerateResult>;
    generateStep(content?: string, opts?: StepOptions): Promise<StepResult>;
  };

  // Tool control (when using generateStep manually)
  executeTool(call: ToolCall): Promise<ToolResult>;
  toolResult(callId: string, result: unknown): Promise<void>;

  // Message control (Tymbal abstraction)
  message(value: Record<string, unknown>): MessageHandle;
  history: Message[];

  // Completion
  complete(result?: unknown): Promise<void>;

  // Termination handling
  onTerminate(handler: () => Promise<unknown>): void;

  // Sub-agents and workflows
  spawn(name: string, input: unknown): Promise<AgentHandle>;

  // Inter-agent messaging
  sendTo(threadId: string, payload: unknown): Promise<SentMessage>;
  reply(message: AgentMessage, payload: unknown): Promise<SentMessage>;

  // Durable execution
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  // Parallel execution
  parallel<T extends readonly unknown[]>(
    name: string,
    fns: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T>;

  map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts?: { maxConcurrency?: number }
  ): Promise<R[]>;

  // Context
  config: AgentConfig;
  threadId: string;
  input?: unknown; // Input from spawn() - set for sub-agents/workflows
}

// =============================================================================
// Agent Config
// =============================================================================

export interface AgentConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// =============================================================================
// Agent Definition
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentDefinition<TTools extends Record<string, ToolDefinition<any>> = Record<string, ToolDefinition<any>>> {
  kind: "agent";
  name?: string;
  system: string;
  config?: AgentConfig;
  tools?: TTools;
  onEvent?: (event: FlowEvent, ctx: Context) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DefineAgentOptions<TTools extends Record<string, ToolDefinition<any>> = Record<string, ToolDefinition<any>>> {
  name?: string;
  system: string;
  config?: AgentConfig;
  tools?: TTools;
  onEvent?: (event: FlowEvent, ctx: Context) => Promise<void>;
}

// =============================================================================
// Workflow Definition
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WorkflowDefinition<TTools extends Record<string, ToolDefinition<any>> = Record<string, ToolDefinition<any>>, TResult = unknown> {
  kind: "workflow";
  name?: string;
  system: string;
  config?: AgentConfig;
  tools?: TTools;
  onFlow: (ctx: Context) => Promise<TResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DefineWorkflowOptions<TTools extends Record<string, ToolDefinition<any>> = Record<string, ToolDefinition<any>>, TResult = unknown> {
  name?: string;
  system: string;
  config?: AgentConfig;
  tools?: TTools;
  onFlow: (ctx: Context) => Promise<TResult>;
}

// =============================================================================
// Union Type for Both
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProcessDefinition<TTools extends Record<string, ToolDefinition<any>> = Record<string, ToolDefinition<any>>> =
  | AgentDefinition<TTools>
  | WorkflowDefinition<TTools>;
