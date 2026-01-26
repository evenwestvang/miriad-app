import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import type { Message, MessageType, AgentState, AgentOutput } from "../types";
import { apiFetch, API_HOST } from "../lib/api";

// Artifact event from WebSocket stream
export interface ArtifactEvent {
  action: "created" | "updated" | "archived";
  artifact: {
    slug: string;
    channelId: string;
    type: string;
    title?: string;
    tldr: string;
    status: string;
    parentSlug?: string;
    [key: string]: unknown;
  };
}

// Roster event from WebSocket stream
export interface RosterEvent {
  action: "agent_joined" | "agent_dismissed";
  agent: {
    callsign: string;
    agentType: string;
    status?: string;
    runtimeId?: string | null;
    runtimeName?: string;
    runtimeStatus?: "online" | "offline";
  };
}

// Roster state event - agent lifecycle changes from backend
export interface RosterStateEvent {
  callsign: string;
  state:
    | "connecting"
    | "online"
    | "offline"
    | "paused"
    | "resumed"
    | "pending"
    | "dismissed";
  /** ISO timestamp of last heartbeat (for client-side offline timeout tracking) */
  lastHeartbeat?: string;
  /** ISO timestamp of when message was routed (for client-side pending timeout tracking) */
  lastMessageRoutedAt?: string;
}

// Tymbal protocol types
interface TymbalFrame {
  i: string; // ULID
  t?: string; // Timestamp (ISO)
  m?: MessageMetadata; // Start frame metadata
  a?: string; // Append content
  v?: MessageValue | null; // Set value (null = reset)
  c?: string; // Channel ID (server injects this for client routing)
  request?: string; // Sync request
  error?: string; // Error code
  message?: string; // Error message
}

interface MessageMetadata {
  type: MessageType;
  sender: string;
  senderType: "user" | "agent";
}

interface MessageValue {
  type: MessageType;
  content?: string;
  sender: string;
  senderType: "user" | "agent";
  // For agent_output frames
  agentOutput?: AgentOutput;
  // For agent_state frames
  state?: AgentState | string; // AgentState for agent_state frames, string for message state (pending/completed/dismissed)
  toolName?: string;
  // For tool_call frames (flat format)
  toolCallId?: string;
  name?: string;
  args?: Record<string, unknown>;
  // For tool_result frames (flat format)
  isError?: boolean;
  // Method used to send the message (e.g., 'send_message' for intentional agent messages)
  method?: string;
  // Attachment slugs (asset artifact slugs attached to this message)
  attachmentSlugs?: string[];
}

// Agent state info for UI
export interface AgentStateInfo {
  state: AgentState;
  toolName?: string;
  updatedAt: number;
}

// Type guards
function isSetFrame(
  frame: TymbalFrame,
): frame is TymbalFrame & { t: string; v: MessageValue } {
  return "v" in frame && frame.v !== null && "t" in frame;
}

function isAppendFrame(
  frame: TymbalFrame,
): frame is TymbalFrame & { a: string } {
  return "a" in frame;
}

function isStartFrame(frame: TymbalFrame): boolean {
  // StartFrame: has 'i' but no 'a', no 'v', not a request, not an error
  // May or may not have 'm' (metadata)
  return (
    "i" in frame &&
    !("a" in frame) &&
    !("v" in frame) &&
    !("request" in frame) &&
    !("error" in frame)
  );
}

function isResetFrame(frame: TymbalFrame): frame is TymbalFrame & { v: null } {
  return "v" in frame && frame.v === null;
}

function isErrorFrame(
  frame: TymbalFrame,
): frame is TymbalFrame & { error: string } {
  return "error" in frame;
}

interface SyncInfo {
  /** Whether there are more messages older than what we've loaded */
  hasMore: boolean;
  /** ID of the oldest message loaded (use as 'before' cursor for pagination) */
  oldestId?: string;
}

// Cost frame data from agent turns
export interface CostInfo {
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

interface UseTymbalConnectionOptions {
  channelId: string | null;
  onMessage: (message: Message) => void;
  onMessageUpdate: (id: string, content: string) => void;
  onAgentStateChange?: (agent: string, state: AgentStateInfo) => void;
  onArtifactEvent?: (event: ArtifactEvent) => void;
  onRosterEvent?: (event: RosterEvent) => void;
  /** Called when backend broadcasts agent lifecycle state (online/offline/connecting) */
  onRosterStateEvent?: (event: RosterStateEvent) => void;
  /** Called when an agent sends an idle frame (turn complete) */
  onAgentIdle?: (sender: string) => void;
  /** Called when an agent reports cost data (after each turn) */
  onCostFrame?: (callsign: string, cost: CostInfo) => void;
  /** Called when sync completes (useful for clearing loading states) */
  onSyncComplete?: (syncInfo?: SyncInfo) => void;
  currentUser?: string;
  /** Pre-fetched WebSocket auth token (avoids re-fetch on every channel switch) */
  wsToken?: string;
  /** ID (ULID) of newest cached message - use for incremental sync */
  newestCachedMessageId?: string;
}

interface PendingMessage {
  metadata: MessageMetadata;
  buffer: string;
  startedAt: number;
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
  onRosterStateEvent,
  onAgentIdle,
  onCostFrame,
  onSyncComplete,
  currentUser = "user",
  wsToken: providedWsToken,
  newestCachedMessageId,
}: UseTymbalConnectionOptions) {
  const [connected, setConnected] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [agentStates, setAgentStates] = useState<Map<string, AgentStateInfo>>(
    new Map(),
  );
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingMessages = useRef<Map<string, PendingMessage>>(new Map());
  const agentOutputBuffers = useRef<
    Map<string, { buffer: string; messageId: string }>
  >(new Map());
  const lastTimestampRef = useRef<string | null>(null);
  const oldestMessageIdRef = useRef<string | null>(null);

  // Reconnection state
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectAttemptRef = useRef(0);
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000; // 1 second

  // Parse a single frame from JSON string
  const parseFrame = useCallback((line: string): TymbalFrame | null => {
    try {
      return JSON.parse(line) as TymbalFrame;
    } catch {
      console.warn("Failed to parse frame:", line);
      return null;
    }
  }, []);

  // Fallback ref for channelId (used if server doesn't send 'c' field)
  const channelIdRef = useRef<string | null>(channelId);
  channelIdRef.current = channelId;

  // Process incoming Tymbal frames
  // Server includes channelId ('c' field) on each frame for reliable routing
  const processFrame = useCallback(
    (frame: TymbalFrame) => {
      // Read channel from frame (server-authoritative), fallback to ref for backwards compatibility
      const currentChannelId = frame.c || channelIdRef.current;

      // Sync response frame - signals end of message history sync
      if ("sync" in frame) {
        const syncFrame = frame as {
          sync: string;
          hasMore?: boolean;
          oldestId?: string;
        };
        console.log(
          `[ChannelSwitch] Sync complete at ${performance.now().toFixed(2)}ms, hasMore=${syncFrame.hasMore}, oldestId=${syncFrame.oldestId}`,
        );

        // Update pagination state
        if (syncFrame.hasMore !== undefined) {
          setHasMoreMessages(syncFrame.hasMore);
        }
        if (syncFrame.oldestId) {
          // Only update if this is older than what we have (or first load)
          if (
            !oldestMessageIdRef.current ||
            syncFrame.oldestId < oldestMessageIdRef.current
          ) {
            oldestMessageIdRef.current = syncFrame.oldestId;
          }
        }
        setIsLoadingOlder(false);

        onSyncComplete?.({
          hasMore: syncFrame.hasMore ?? true,
          oldestId: syncFrame.oldestId,
        });
        return;
      }

      // Start frame - initialize pending message for streaming
      // Don't emit message yet - wait for first content to avoid empty bubbles
      if (isStartFrame(frame)) {
        // Start frames may have metadata (m) or be bare
        const metadata: MessageMetadata = frame.m || {
          type: "agent" as MessageType,
          sender: "unknown",
          senderType: "agent" as const,
        };
        pendingMessages.current.set(frame.i, {
          metadata,
          buffer: "",
          startedAt: Date.now(),
        });
        return;
      }

      // Append frame - accumulate content for streaming
      if (isAppendFrame(frame)) {
        const pending = pendingMessages.current.get(frame.i);
        if (pending) {
          const isFirstContent = pending.buffer === "";
          pending.buffer += frame.a;

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
            });
          } else {
            // Subsequent chunks - emit update for progressive rendering
            onMessageUpdate(frame.i, pending.buffer);
          }
        }
        return;
      }

      // Set frame - complete message (most common from server)
      if (isSetFrame(frame)) {
        pendingMessages.current.delete(frame.i);
        lastTimestampRef.current = frame.t;

        const value = frame.v;

        // Handle agent_state frames - lifecycle updates
        if (value.type === "agent_state" && value.state) {
          const agentKey = `${currentChannelId}:${value.sender}`;
          const stateInfo: AgentStateInfo = {
            state: value.state as AgentState,
            toolName: value.toolName,
            updatedAt: Date.now(),
          };

          // Handle roster lifecycle states (from backend heartbeat)
          // Client handles offline timeout locally using lastHeartbeat timestamp
          const rosterStates = [
            "online",
            "offline",
            "connecting",
            "paused",
            "pending",
            "dismissed",
          ] as const;
          const stateStr = value.state as string;
          if (
            rosterStates.includes(stateStr as (typeof rosterStates)[number])
          ) {
            const event: RosterStateEvent = {
              callsign: value.sender,
              state: stateStr as
                | "connecting"
                | "online"
                | "offline"
                | "paused"
                | "pending"
                | "dismissed",
            };
            // Include lastHeartbeat for client-side timeout tracking
            if (
              "lastHeartbeat" in value &&
              typeof value.lastHeartbeat === "string"
            ) {
              event.lastHeartbeat = value.lastHeartbeat as string;
            }
            // Include lastMessageRoutedAt for pending state timeout tracking
            if (
              "lastMessageRoutedAt" in value &&
              typeof value.lastMessageRoutedAt === "string"
            ) {
              event.lastMessageRoutedAt = value.lastMessageRoutedAt as string;
            }
            onRosterStateEvent?.(event);
            return;
          }

          setAgentStates((prev) => {
            const next = new Map(prev);
            if (value.state === "stopped" || value.state === "idle") {
              // Clear agent state when done or idle
              next.delete(agentKey);
            } else {
              next.set(agentKey, stateInfo);
            }
            return next;
          });

          onAgentStateChange?.(value.sender, stateInfo);

          // If transitioning to idle or stopped, mark response as complete
          if (value.state === "idle" || value.state === "stopped") {
            setIsWaitingForResponse(false);
            const bufferKey = `${currentChannelId}:${value.sender}`;
            const buffer = agentOutputBuffers.current.get(bufferKey);
            if (buffer && buffer.buffer) {
              onMessageUpdate(buffer.messageId, buffer.buffer);
              agentOutputBuffers.current.delete(bufferKey);
            }
          }
          return;
        }

        // Handle agent_output frames - streaming agent responses
        if (value.type === "agent_output" && value.agentOutput) {
          const agentKey = `${currentChannelId}:${value.sender}`;
          const output = value.agentOutput;

          if (output.type === "text") {
            // Accumulate text output
            let buffer = agentOutputBuffers.current.get(agentKey);
            const isFirstChunk = !buffer;

            if (!buffer) {
              // First chunk - create buffer but defer message emission
              buffer = { buffer: "", messageId: frame.i };
              agentOutputBuffers.current.set(agentKey, buffer);
            }

            buffer.buffer += output.content;

            if (isFirstChunk) {
              // Emit message with initial content (not empty)
              onMessage({
                id: frame.i,
                channelId: currentChannelId!,
                type: "agent",
                content: buffer.buffer,
                sender: value.sender,
                senderType: "agent",
                timestamp: frame.t,
              });
            } else {
              // Subsequent chunks - update existing message
              onMessageUpdate(buffer.messageId, buffer.buffer);
            }
          } else if (output.type === "tool_use") {
            // Tool invocation - emit as tool_call message with all tool fields
            onMessage({
              id: frame.i,
              channelId: currentChannelId!,
              type: "tool_call",
              content: "",
              sender: value.sender,
              senderType: "agent",
              timestamp: frame.t,
              toolCallId: output.toolCallId,
              toolName: output.toolName,
              toolArgs: output.arguments,
            });
          } else if (output.type === "tool_result") {
            // Tool result - emit as tool_result message with all result fields
            const isError = output.status === "error";
            onMessage({
              id: frame.i,
              channelId: currentChannelId!,
              type: "tool_result",
              content: "",
              sender: value.sender,
              senderType: "agent",
              timestamp: frame.t,
              toolResultCallId: output.toolCallId,
              toolResultStatus: isError ? "error" : "success",
              toolResultOutput: output.output ?? output.content,
              toolResultError: isError ? output.error : undefined,
            });
          }
          return;
        }

        // Handle artifact events from board operations
        if (value.type === "artifact" && onArtifactEvent) {
          const artifactValue = value as unknown as {
            action: string;
            artifact: ArtifactEvent["artifact"];
          };
          if (artifactValue.action && artifactValue.artifact) {
            onArtifactEvent({
              action: artifactValue.action as ArtifactEvent["action"],
              artifact: artifactValue.artifact,
            });
          }
          return;
        }

        // Handle roster events (agent_joined, agent_dismissed)
        if (value.type === "roster" && onRosterEvent) {
          const rosterValue = value as unknown as {
            action: string;
            agent: RosterEvent["agent"];
          };
          if (rosterValue.action && rosterValue.agent) {
            onRosterEvent({
              action: rosterValue.action as RosterEvent["action"],
              agent: rosterValue.agent,
            });
          }
          return;
        }

        // Handle cost frames - agent turn cost reporting
        if ((value.type as string) === "cost" && onCostFrame) {
          const costValue = value as unknown as {
            sender: string;
            totalCostUsd: number;
            durationMs: number;
            numTurns: number;
            usage?: {
              inputTokens: number;
              outputTokens: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            };
          };
          onCostFrame(costValue.sender, {
            totalCostUsd: costValue.totalCostUsd,
            durationMs: costValue.durationMs,
            numTurns: costValue.numTurns,
            usage: costValue.usage,
          });
          return;
        }

        // Handle tool_call frames - tool data is flat on value
        if (value.type === "tool_call") {
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: "tool_call",
            content: "",
            sender: value.sender || "agent",
            senderType: "agent",
            timestamp: frame.t,
            toolCallId: value.toolCallId,
            toolName: value.name,
            toolArgs: value.args,
          });
          return;
        }

        // Handle tool_result frames - result data is flat on value
        if (value.type === "tool_result") {
          const isError = value.isError === true;
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: "tool_result",
            content: "",
            sender: value.sender || "agent",
            senderType: "agent",
            timestamp: frame.t,
            toolResultCallId: value.toolCallId,
            toolResultStatus: isError ? "error" : "success",
            toolResultOutput: value.content,
            toolResultError: isError ? value.content : undefined,
          });
          return;
        }

        // Standard message handling - whitelist approach
        // Only render known renderable message types
        const renderableTypes = [
          "event",
          "user",
          "agent",
          "error",
          "status",
          "attachment",
          "structured_ask",
          "idle",
          "thinking",
        ];
        if (!renderableTypes.includes(value.type)) {
          // Render unrecognized types as error messages for visibility
          // This catches compliance issues (e.g., old 'assistant' type from stored data)
          console.error(
            "[Tymbal] Unrecognized message type:",
            value.type,
            frame.i,
            value,
          );
          onMessage({
            id: frame.i,
            channelId: currentChannelId!,
            type: "error",
            content: `Unrecognized message type: "${value.type}"\n\nRaw: ${JSON.stringify(value, null, 2)}`,
            sender: "system",
            senderType: "agent",
            timestamp: frame.t,
          });
          return;
        }

        // Skip non-renderable types that we recognize but don't display
        if (value.type === "idle") {
          // idle: turn completion signal - notify App to update roster working state
          if (value.sender) {
            onAgentIdle?.(value.sender);
          }
          return;
        }
        if (value.type === "thinking") {
          // thinking: internal traces - don't render as bubbles
          return;
        }

        // Skip empty agent messages to avoid empty bubbles
        if (value.type === "agent" && !value.content) {
          return;
        }

        // Clear waiting state when we get an agent message
        if (value.senderType === "agent" && value.type === "agent") {
          setIsWaitingForResponse(false);
        }
        onMessage({
          id: frame.i,
          channelId: currentChannelId!,
          type: value.type,
          content: value.content ?? "",
          sender: value.sender,
          senderType: value.senderType,
          timestamp: frame.t,
          method: value.method,
          attachmentSlugs: value.attachmentSlugs,
          state: typeof value.state === "string" ? value.state : undefined,
        });
        return;
      }

      // Reset frame - delete message
      if (isResetFrame(frame)) {
        pendingMessages.current.delete(frame.i);
        // TODO: Emit delete event
        return;
      }

      // Error frame
      if (isErrorFrame(frame)) {
        console.error("Tymbal error:", frame.error, frame.message);
        return;
      }
    },
    [
      onMessage,
      onMessageUpdate,
      onArtifactEvent,
      onRosterEvent,
      onRosterStateEvent,
      onAgentIdle,
      onCostFrame,
      onSyncComplete,
    ],
  );

  // Track current channel for the WebSocket
  const currentChannelRef = useRef<string | null>(null);
  // Track the desired channel (for onopen to read latest value)
  const desiredChannelRef = useRef<string | null>(channelId);

  // Track newest cached message ID per channel for incremental sync
  const newestCachedMessageIdRef = useRef<string | undefined>(
    newestCachedMessageId,
  );
  newestCachedMessageIdRef.current = newestCachedMessageId;

  // Send sync request to switch/sync channel
  const sendSyncRequest = useCallback(
    (targetChannelId: string) => {
      console.log(
        `[ChannelSwitch] sendSyncRequest called for ${targetChannelId}, newestCachedMessageId=${newestCachedMessageIdRef.current}`,
      );
      const ws = wsRef.current;
      if (!ws) {
        console.log(`[ChannelSwitch] sendSyncRequest: ws is null`);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(
          `[ChannelSwitch] sendSyncRequest: ws not open, state=${ws.readyState}`,
        );
        return;
      }

      const syncRequest: Record<string, unknown> = {
        request: "sync",
        channelId: targetChannelId,
      };
      // Use cached message ID (ULID) for incremental sync if available
      // newestCachedMessageIdRef.current is computed for the target channel in App.tsx
      // If undefined, this is a new/uncached channel - fetch full history
      if (newestCachedMessageIdRef.current) {
        syncRequest.since = newestCachedMessageIdRef.current;
        console.log(
          `[ChannelSwitch] Using cached message ID for incremental sync: ${newestCachedMessageIdRef.current}`,
        );
      }
      // Note: lastTimestampRef is for live updates on same channel, not used for channel switches
      if (providedWsToken) {
        syncRequest.token = providedWsToken;
      }
      console.log(
        `[ChannelSwitch] Sync request sent at ${performance.now().toFixed(2)}ms`,
        syncRequest,
      );
      ws.send(JSON.stringify(syncRequest));
      currentChannelRef.current = targetChannelId;
    },
    [providedWsToken],
  );

  // Request older messages (for infinite scroll)
  const requestOlderMessages = useCallback(
    (limit = 25) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log(
          "[Pagination] Cannot request older messages: WebSocket not ready",
        );
        return;
      }
      if (!channelId) {
        console.log("[Pagination] Cannot request older messages: no channel");
        return;
      }
      if (!hasMoreMessages) {
        console.log("[Pagination] No more messages to load");
        return;
      }
      if (isLoadingOlder) {
        console.log("[Pagination] Already loading older messages");
        return;
      }
      if (!oldestMessageIdRef.current) {
        console.log("[Pagination] No oldest message ID yet");
        return;
      }

      setIsLoadingOlder(true);
      const syncRequest: Record<string, unknown> = {
        request: "sync",
        channelId,
        before: oldestMessageIdRef.current,
        limit,
      };
      if (providedWsToken) {
        syncRequest.token = providedWsToken;
      }
      console.log("[Pagination] Requesting older messages:", syncRequest);
      ws.send(JSON.stringify(syncRequest));
    },
    [channelId, hasMoreMessages, isLoadingOlder, providedWsToken],
  );

  // Create WebSocket connection (used for initial connect and reconnect)
  const createWebSocket = useCallback(() => {
    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const wsUrlEnv = import.meta.env.VITE_WS_URL;
    const isAwsWs =
      wsUrlEnv &&
      (wsUrlEnv.includes("execute-api") ||
        (wsUrlEnv.startsWith("wss://") && !wsUrlEnv.includes("localhost")));

    let wsUrl: string;
    if (wsUrlEnv) {
      if (isAwsWs) {
        wsUrl = wsUrlEnv;
      } else {
        wsUrl = `${wsUrlEnv}/stream`;
      }
    } else {
      const wsBase = API_HOST.replace(/^http/, "ws");
      wsUrl = `${wsBase}/stream`;
    }

    console.log(
      `[WebSocket] Creating connection to ${wsUrl} (attempt ${reconnectAttemptRef.current + 1})`,
    );
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0; // Reset on successful connect
      console.log(`[WebSocket] Connected at ${performance.now().toFixed(2)}ms`);
      // Send sync for current desired channel
      const target = desiredChannelRef.current;
      if (target) {
        console.log(`[WebSocket] Sending initial sync for ${target}`);
        sendSyncRequest(target);
      }
    };

    ws.onclose = (event) => {
      console.log(
        `[WebSocket] Closed: code=${event.code}, reason=${event.reason}`,
      );
      setConnected(false);
      wsRef.current = null;

      // Don't reconnect on intentional close (code 1000) or if we've exceeded max attempts
      if (event.code === 1000) {
        console.log("[WebSocket] Clean close, not reconnecting");
        return;
      }

      if (reconnectAttemptRef.current >= maxReconnectAttempts) {
        console.error(
          `[WebSocket] Max reconnect attempts (${maxReconnectAttempts}) reached, giving up`,
        );
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 32s)
      const delay = Math.min(
        baseReconnectDelay * Math.pow(2, reconnectAttemptRef.current),
        32000,
      );
      reconnectAttemptRef.current++;
      console.log(
        `[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current}/${maxReconnectAttempts})`,
      );

      reconnectTimeoutRef.current = setTimeout(() => {
        createWebSocket();
      }, delay);
    };

    ws.onerror = (error) => {
      console.error("[WebSocket] Error:", error);
    };

    ws.onmessage = (event) => {
      const lines = (event.data as string).split("\n").filter(Boolean);
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame) {
          processFrame(frame);
        }
      }
    };

    return ws;
  }, [sendSyncRequest, parseFrame, processFrame]);

  // Manage WebSocket connection and channel switching
  useLayoutEffect(() => {
    console.log(
      `[ChannelSwitch] Main effect: channelId=${channelId}, wsRef=${wsRef.current ? "exists" : "null"}`,
    );

    // Update desired channel ref
    desiredChannelRef.current = channelId;

    // Create WebSocket if we don't have one
    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      createWebSocket();
    }

    // If WebSocket exists and is open, send sync for channel change
    if (channelId && channelId !== currentChannelRef.current) {
      console.log(`[ChannelSwitch] Channel changed to ${channelId}`);
      lastTimestampRef.current = null; // Reset for new channel
      oldestMessageIdRef.current = null; // Reset pagination cursor
      setHasMoreMessages(true); // Assume more messages until proven otherwise

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[ChannelSwitch] Sending sync for channel switch`);
        sendSyncRequest(channelId);
      } else {
        console.log(
          `[ChannelSwitch] WebSocket not ready (state=${ws?.readyState}), will sync on open`,
        );
      }
    }

    if (!channelId) {
      currentChannelRef.current = null;
    }
  }, [channelId, sendSyncRequest, createWebSocket]);

  // Cleanup WebSocket and reconnect timeout on unmount
  useEffect(() => {
    return () => {
      console.log(
        "[WebSocket] Cleanup: closing WebSocket and clearing reconnect timeout",
      );
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      wsRef.current?.close(1000, "Component unmounting"); // Use 1000 to prevent reconnect
      wsRef.current = null;
    };
  }, []);

  // Send a user message via HTTP POST (server assigns ID)
  // Returns the message ID on success, or undefined on failure
  // Optional attachSlugs: array of artifact slugs to attach to this message
  const sendMessage = useCallback(
    async (
      content: string,
      attachSlugs?: string[],
    ): Promise<string | undefined> => {
      if (!channelId) {
        console.error("No channel selected");
        return undefined;
      }

      setIsWaitingForResponse(true);

      try {
        const body: Record<string, unknown> = {
          content,
          sender: currentUser,
          senderType: "user",
        };
        if (attachSlugs && attachSlugs.length > 0) {
          body.attachSlugs = attachSlugs;
        }

        const response = await apiFetch(`/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          setIsWaitingForResponse(false);
          throw new Error(`Failed to send message: ${response.status}`);
        }

        // Message will arrive via WebSocket - response state will be cleared when we get a reply
        const data = await response.json();
        return data.id as string;
      } catch (error) {
        console.error("Failed to send message:", error);
        setIsWaitingForResponse(false);
        return undefined;
      }
    },
    [channelId, currentUser],
  );

  return {
    connected,
    isWaitingForResponse,
    sendMessage,
    agentStates,
    // Pagination
    hasMoreMessages,
    isLoadingOlder,
    requestOlderMessages,
  };
}

export type { SyncInfo };
