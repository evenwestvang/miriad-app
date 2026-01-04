/**
 * Shared Types for Reactive Agent
 */

import type { BroadcastAdapter } from "./adapters/broadcast.js";
import type { LLMAdapter, LLMMessage } from "./adapters/llm.js";
import type { ToolAdapter } from "./adapters/tools.js";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for running a reactive agent turn.
 */
export interface ReactiveAgentConfig {
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  /** Space ID (tenant) */
  spaceId: string;

  /** Channel ID */
  channelId: string;

  /** Agent's callsign */
  agentCallsign: string;

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /** The user message to process */
  userMessage: string;

  /** System prompt for the agent */
  systemPrompt: string;

  /** Conversation history - required, the reactive agent is stateless */
  conversationHistory: LLMMessage[];

  // ---------------------------------------------------------------------------
  // Adapters (injected)
  // ---------------------------------------------------------------------------

  /** Broadcast adapter for real-time streaming */
  broadcast: BroadcastAdapter;

  /** LLM adapter for AI responses */
  llm: LLMAdapter;

  /** Tool adapter for tool discovery and execution (optional) */
  tools?: ToolAdapter;

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  /** Model to use (defaults to claude-sonnet-4-20250514) */
  model?: string;

  /** Maximum tokens per response */
  maxTokens?: number;

  /** Maximum turns in the agentic loop (default: 20) */
  maxTurns?: number;
}

/**
 * Result of running a reactive agent turn.
 */
export interface ReactiveAgentResult {
  /** Final assistant response text */
  response: string;

  /** Number of turns in the agentic loop */
  numTurns: number;

  /** Total duration in milliseconds */
  durationMs: number;

  /** Message IDs persisted */
  messageIds: string[];
}

// =============================================================================
// Tool Call Types
// =============================================================================

/**
 * A tool call requested by the LLM.
 */
export interface ToolCall {
  /** Unique call identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  args: Record<string, unknown>;
}

/**
 * Result of a single LLM generation step.
 */
export interface StepResult {
  /** Generated text content */
  text: string;
  /** Tool calls requested by the LLM */
  toolCalls: ToolCall[];
  /** Reason the LLM stopped */
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}
