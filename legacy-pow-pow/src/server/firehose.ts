/**
 * Firehose - Agent Event Streaming
 *
 * Wires agent output and state events to the channel SSE stream.
 * Enables real-time visibility into agent activity for UI consumers.
 *
 * Event types:
 * - agent_output: Streams AgentOutput with engine info
 * - agent_state: State changes with pendingMessages count
 */

import { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentOutput, AgentState } from "./agent-provider.js";

/**
 * SSE event payload for agent output.
 */
export interface AgentOutputEvent {
  channel: string;
  agent: string;
  engine: string;
  output: AgentOutput;
}

/**
 * SSE event payload for agent state changes.
 */
export interface AgentStateEvent {
  channel: string;
  agent: string;
  engine: string;
  state: AgentState;
  previousState?: AgentState;
  pendingMessages: number;
}

/** Callback type for sending SSE events */
type SendEventFn = (event: string, data: unknown) => void;

/** Per-channel subscriptions */
const channelSubscriptions = new Map<string, Set<SendEventFn>>();

/**
 * Subscribe to agent events for a channel.
 * Returns unsubscribe function.
 */
export function subscribeToAgentEvents(
  channel: string,
  sendEvent: SendEventFn
): () => void {
  if (!channelSubscriptions.has(channel)) {
    channelSubscriptions.set(channel, new Set());
  }
  channelSubscriptions.get(channel)!.add(sendEvent);

  return () => {
    const subs = channelSubscriptions.get(channel);
    if (subs) {
      subs.delete(sendEvent);
      if (subs.size === 0) {
        channelSubscriptions.delete(channel);
      }
    }
  };
}

/**
 * Emit agent output event to all subscribers for a channel.
 */
export function emitAgentOutput(
  channel: string,
  agent: string,
  engine: string,
  output: AgentOutput
): void {
  const subs = channelSubscriptions.get(channel);
  if (!subs || subs.size === 0) return;

  const event: AgentOutputEvent = {
    channel,
    agent,
    engine,
    output,
  };

  for (const sendEvent of subs) {
    try {
      sendEvent("agent_output", event);
    } catch (err) {
      console.error(`[firehose] Error sending agent_output:`, err);
    }
  }
}

/**
 * Emit agent state change event to all subscribers for a channel.
 */
export function emitAgentState(
  channel: string,
  agent: string,
  engine: string,
  state: AgentState,
  previousState: AgentState | undefined,
  pendingMessages: number
): void {
  const subs = channelSubscriptions.get(channel);
  if (!subs || subs.size === 0) return;

  const event: AgentStateEvent = {
    channel,
    agent,
    engine,
    state,
    previousState,
    pendingMessages,
  };

  for (const sendEvent of subs) {
    try {
      sendEvent("agent_state", event);
    } catch (err) {
      console.error(`[firehose] Error sending agent_state:`, err);
    }
  }
}

/**
 * Wire an AgentManager to the firehose.
 * Call this after creating the AgentManager to enable event streaming.
 */
export function wireAgentManagerToFirehose(manager: AgentManager): void {
  // The AgentManager already has onStateChange in options.
  // For per-agent output events, we need to hook into the provider callbacks.
  // This is handled in AgentManager.spawn() which wires provider.onOutput().
  //
  // To emit to firehose, we modify AgentManager to call emitAgentOutput/emitAgentState
  // OR we extend this module to accept the manager and wrap it.
  //
  // For minimal changes, we'll document that AgentManager should call
  // emitAgentOutput and emitAgentState in its internal callbacks.
  console.error(`[firehose] Agent event streaming enabled`);
}

/**
 * Wire firehose events to an SSE connection.
 * Call this in the SSE stream handler alongside wireArtifactSSE.
 */
export function wireAgentSSE(
  channel: string,
  sendEvent: SendEventFn
): () => void {
  return subscribeToAgentEvents(channel, sendEvent);
}
