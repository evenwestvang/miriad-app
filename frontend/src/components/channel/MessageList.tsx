import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
} from "react";
import Markdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { format, isToday, isYesterday, isThisWeek, isThisYear } from "date-fns";
import {
  Copy,
  Check,
  CirclePlus,
  AlertCircle,
  MoreVertical,
  Bed,
  Coffee,
  ArrowRight,
} from "lucide-react";
import type { Message, StructuredAskMessage } from "../../types";
import { highlightMentions, type ArtifactInfo } from "../../utils";
import { ToolGroup } from "./ToolGroup";
import { StructuredAskForm } from "../structured-ask";
import { MessageAttachments, AssetRenderer } from "./AttachmentRenderer";
import { ChannelEmptyState } from "./ChannelEmptyState";
import { RootChannelEmptyState } from "./RootChannelEmptyState";
import { FirstChannelEmptyState } from "./FirstChannelEmptyState";
import type { AttachmentMessageContent } from "../../types";
// Avatar components kept for potential future use
// import { AgentAvatar, UserAvatar } from './AgentAvatar'
import { Cartouche } from "./Cartouche";
import type { RosterAgent } from "./MentionAutocomplete";
import { apiFetch } from "../../lib/api";
import { useIsDarkMode } from "../../hooks/useIsDarkMode";

/**
 * Copy button with checkmark feedback
 */
function CopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded hover:bg-secondary/80 transition-colors ${className}`}
      title={copied ? "Copied!" : "Copy"}
    >
      {copied ? (
        <Check size={14} className="text-green-500" />
      ) : (
        <Copy size={14} className="text-muted-foreground" />
      )}
    </button>
  );
}

/**
 * Message menu with copy and future options
 */
function MessageMenu({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setIsOpen(false);
      }, 1000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-0.5 rounded hover:bg-secondary/80 transition-colors opacity-0 group-hover:opacity-100 relative top-[1px]"
        title="More options"
      >
        <MoreVertical size={14} className="text-[var(--cast-text-muted)]" />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md shadow-lg z-50 whitespace-nowrap">
          <button
            onClick={handleCopy}
            className="w-full flex items-center gap-2 px-3 py-2 text-base hover:bg-secondary/50 transition-colors"
          >
            {copied ? (
              <>
                <Check size={14} className="text-green-500" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>Copy message</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Unified message header with Cartouche, callsign, agent type, timestamp, and optional menu.
 * Used by all message types for consistent styling.
 */
interface MessageHeaderProps {
  name: string;
  displayName: string;
  agentType?: string;
  timestamp: string;
  channelId: string;
  rosterIndex: number;
  /** Whether sender is a human (renders square instead of circle) */
  isHuman?: boolean;
  /** Optional content for copy menu (omit to hide menu) */
  menuContent?: string;
}

function MessageHeader({
  name,
  displayName,
  agentType,
  timestamp,
  channelId,
  rosterIndex,
  isHuman,
  menuContent,
}: MessageHeaderProps) {
  return (
    <>
      {/* Cartouche in left gutter, centered horizontally and aligned with text */}
      <div className="absolute -left-[22px] top-[6px] flex justify-center w-4">
        <Cartouche
          name={name}
          channelId={channelId}
          rosterIndex={rosterIndex}
          isHuman={isHuman}
          className="text-[14px]"
        />
      </div>
      {/* Header line with callsign, agent type, timestamp, menu */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--cast-text-primary)]">
          {displayName}
        </span>
        {agentType && (
          <span className="text-[14px] font-normal text-[var(--cast-text-muted)]">
            {agentType}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {menuContent !== undefined && <MessageMenu content={menuContent} />}
          <span className="text-[14px] text-[var(--cast-text-muted)]">
            {formatTime(timestamp)}
          </span>
        </span>
      </div>
    </>
  );
}

interface MessageListProps {
  messages: Message[];
  threadName?: string;
  threadAgentType?: string;
  myName?: string;
  /** API host for attachment URLs */
  apiHost?: string;
  /** Channel ID for artifact lookup */
  channelId?: string;
  /** Space ID for runtime lookup */
  spaceId?: string;
  /** Roster for agent type lookup */
  roster?: RosterAgent[];
  /** True immediately when channel switch starts (hides empty state) */
  isSwitching?: boolean;
  /** Show loading spinner (delayed - only after 500ms) */
  isLoading?: boolean;
  /** Whether firehose mode is enabled (expands tool groups by default) */
  firehoseMode?: boolean;
  /** Whether there are more older messages to load */
  hasMoreMessages?: boolean;
  /** Whether currently loading older messages */
  isLoadingOlder?: boolean;
  /** Callback to request older messages */
  onRequestOlderMessages?: () => void;
  onStructuredAskSubmit?: (
    messageId: string,
    response: Record<string, unknown>,
  ) => void;
  /** Callback when user cancels/dismisses a structured ask */
  onStructuredAskCancel?: (messageId: string) => void;
  /** Callback when user selects a starter agent from empty state */
  onSelectStarterAgent?: (agentSlug: string) => void;
}

export function MessageList({
  messages,
  threadName = "Agent",
  threadAgentType,
  myName = "",
  apiHost = "",
  channelId = "",
  spaceId,
  roster = [],
  isSwitching = false,
  isLoading = false,
  firehoseMode = false,
  hasMoreMessages = true,
  isLoadingOlder = false,
  onRequestOlderMessages,
  onStructuredAskSubmit,
  onStructuredAskCancel,
  onSelectStarterAgent,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Create callsign → agentType lookup map from roster
  const agentTypeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of roster) {
      if (agent.agentType) {
        map.set(agent.callsign, agent.agentType);
      }
    }
    return map;
  }, [roster]);

  // Create callsign → roster index map for Cartouche colors
  const rosterIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    roster.forEach((agent, index) => {
      map.set(agent.callsign, index);
    });
    return map;
  }, [roster]);
  const wasAtBottomRef = useRef(true);
  // Track sync state: 'waiting' = no messages yet, 'syncing' = first batch arriving, 'ready' = sync complete
  const syncStateRef = useRef<"waiting" | "syncing" | "ready">("waiting");
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMessageCountRef = useRef(0);

  // Artifact map for [[slug]] title lookup
  const [artifactMap, setArtifactMap] = useState<Map<string, ArtifactInfo>>(
    new Map(),
  );

  // Fetch artifacts for title lookup - delayed to not compete with initial paint
  useEffect(() => {
    if (!channelId || !apiHost || isLoading) {
      if (!channelId) setArtifactMap(new Map());
      return;
    }

    const timeoutId = setTimeout(() => {
      async function fetchArtifacts() {
        console.log(
          `[ChannelSwitch] Starting artifacts fetch at ${performance.now().toFixed(2)}ms`,
        );
        try {
          const response = await apiFetch(
            `${apiHost}/channels/${channelId}/artifacts?limit=500`,
          );
          if (!response.ok) return;
          const data = await response.json();
          console.log(
            `[ChannelSwitch] Artifacts fetch complete at ${performance.now().toFixed(2)}ms`,
          );
          const artifacts = data.artifacts || [];

          const map = new Map<string, ArtifactInfo>();
          for (const artifact of artifacts) {
            map.set(artifact.slug.toLowerCase(), {
              slug: artifact.slug,
              title: artifact.title,
              type: artifact.type,
              contentType: artifact.contentType,
            });
          }
          setArtifactMap(map);
        } catch (error) {
          console.warn("Failed to fetch artifacts for title lookup:", error);
        }
      }
      fetchArtifacts();
    }, 250); // Delay to not compete with initial message sync

    return () => clearTimeout(timeoutId);
  }, [channelId, apiHost, isLoading]);

  // Check if user is at bottom before messages update
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50; // pixels from bottom to consider "at bottom"
    return (
      container.scrollHeight - container.scrollTop <=
      container.clientHeight + threshold
    );
  }, []);

  // Track scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      wasAtBottomRef.current = checkIfAtBottom();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [checkIfAtBottom]);

  // Reset sync state when channel changes (messages cleared)
  useEffect(() => {
    if (messages.length === 0) {
      syncStateRef.current = "waiting";
      prevMessageCountRef.current = 0;
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }
    }
  }, [messages.length === 0]);

  // Track scroll height before render to preserve position
  const scrollHeightBeforeRef = useRef<number>(0);
  const scrollTopBeforeRef = useRef<number>(0);

  // Capture scroll state BEFORE React updates the DOM
  // This runs synchronously before useLayoutEffect
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container) {
      scrollHeightBeforeRef.current = container.scrollHeight;
      scrollTopBeforeRef.current = container.scrollTop;
    }
  });

  // Handle scrolling based on sync state
  useLayoutEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    prevMessageCountRef.current = currentCount;

    if (currentCount === 0) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Detect sync start: going from 0 to having messages
    if (prevCount === 0 && currentCount > 0) {
      syncStateRef.current = "syncing";
    }

    // During sync: keep scrolling to bottom instantly (no animation)
    if (syncStateRef.current === "syncing") {
      container.scrollTop = container.scrollHeight;
      wasAtBottomRef.current = true;

      // Reset the sync completion timer on each new message
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      // After 150ms of no new messages, consider sync complete
      syncTimeoutRef.current = setTimeout(() => {
        syncStateRef.current = "ready";
        syncTimeoutRef.current = null;
      }, 150);
      return;
    }

    // After sync complete: preserve scroll position
    if (syncStateRef.current === "ready") {
      if (wasAtBottomRef.current) {
        // If at bottom, stay at bottom (instant)
        container.scrollTop = container.scrollHeight;
      } else {
        // If scrolled up, preserve position relative to content
        const scrollHeightAfter = container.scrollHeight;
        const heightDiff = scrollHeightAfter - scrollHeightBeforeRef.current;
        if (heightDiff !== 0) {
          container.scrollTop = scrollTopBeforeRef.current + heightDiff;
        }
      }
    }
  }, [messages]);

  // Infinite scroll: Load older messages when scrolling near top or viewport not filled
  useEffect(() => {
    if (
      !onRequestOlderMessages ||
      !hasMoreMessages ||
      isLoadingOlder ||
      isSwitching
    ) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Check if viewport needs to be filled (content doesn't fill the container)
    const checkViewportFill = () => {
      if (syncStateRef.current !== "ready") return;
      if (
        container.scrollHeight <= container.clientHeight &&
        messages.length > 0
      ) {
        console.log(
          "[InfiniteScroll] Viewport not filled, requesting more messages",
        );
        onRequestOlderMessages();
      }
    };

    // Check after sync completes and messages render
    const fillTimeoutId = setTimeout(checkViewportFill, 200);

    // Check when scrolling near the top
    const handleScroll = () => {
      if (syncStateRef.current !== "ready") return;
      const scrollTop = container.scrollTop;
      const threshold = 100; // pixels from top to trigger load

      if (scrollTop < threshold) {
        console.log("[InfiniteScroll] Near top, requesting older messages");
        onRequestOlderMessages();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      clearTimeout(fillTimeoutId);
      container.removeEventListener("scroll", handleScroll);
    };
  }, [
    onRequestOlderMessages,
    hasMoreMessages,
    isLoadingOlder,
    isSwitching,
    messages.length,
  ]);

  return (
    <div
      className="flex-1 overflow-y-auto pt-6 px-6 pl-8 pb-2"
      ref={containerRef}
    >
      {/* Spacer pushes content to bottom when thread is short */}
      <div className="flex flex-col min-h-full">
        <div className="flex-1" />
        {messages.length === 0 ? (
          isSwitching ? (
            // Channel switch in progress
            isLoading ? (
              // Show spinner after 500ms delay
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin mb-4" />
                <p className="text-muted-foreground text-base">
                  Loading messages...
                </p>
              </div>
            ) : // Before 500ms - show nothing (blank screen feels faster)
            null
          ) : // Empty state - only show when NOT switching channels
          threadName === "root" ? (
            // Root channel has a special empty state with Custodian CTA
            <RootChannelEmptyState
              onSpawnCustodian={
                onSelectStarterAgent
                  ? () => onSelectStarterAgent("custodian")
                  : undefined
              }
            />
          ) : threadName === "first-channel" ? (
            // First channel has intro to Miriad with Guide CTA
            <FirstChannelEmptyState
              onSpawnGuide={
                onSelectStarterAgent
                  ? () => onSelectStarterAgent("guide")
                  : undefined
              }
            />
          ) : onSelectStarterAgent ? (
            <ChannelEmptyState
              channelId={channelId}
              apiHost={apiHost}
              onSelectAgent={onSelectStarterAgent}
            />
          ) : (
            // Fallback simple empty state when no starter agent handler provided
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <span className="text-2xl">💬</span>
              </div>
              <p className="text-muted-foreground text-base mb-1">
                Start a conversation with {threadName}
              </p>
              {threadAgentType && (
                <p className="text-xs text-muted-foreground">
                  This is a {threadAgentType} agent
                </p>
              )}
            </div>
          )
        ) : (
          <>
            {/* Loading indicator for older messages */}
            {isLoadingOlder && (
              <div className="flex justify-center py-4">
                <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              </div>
            )}
            {/* "No more messages" indicator */}
            {!hasMoreMessages && messages.length > 0 && (
              <div className="flex justify-center py-4">
                <span className="text-xs text-muted-foreground">
                  Beginning of conversation
                </span>
              </div>
            )}
            {(() => {
              const groupedItems = groupMessages(messages);

              // Helper to get the last message of a grouped item (for sender comparison)
              const getLastMessageOfItem = (
                item: MessageOrGroup,
              ): Message | null => {
                if (item.type === "tool_group") {
                  return item.messages[item.messages.length - 1] || null;
                }
                return item.message;
              };

              // Helper to get the first message of a grouped item
              const getFirstMessageOfItem = (
                item: MessageOrGroup,
              ): Message | null => {
                if (item.type === "tool_group") {
                  return item.messages[0] || null;
                }
                return item.message;
              };

              return groupedItems.map((item, groupIndex) => {
                const isLastItem = groupIndex === groupedItems.length - 1;
                const prevItem =
                  groupIndex > 0 ? groupedItems[groupIndex - 1] : null;
                const nextItem =
                  groupIndex < groupedItems.length - 1
                    ? groupedItems[groupIndex + 1]
                    : null;

                // Get the last message from the previous item (for header/margin decisions)
                const prevLastMessage = prevItem
                  ? getLastMessageOfItem(prevItem)
                  : null;

                if (item.type === "tool_group") {
                  // Render grouped tool messages
                  const firstMsg = item.messages[0];
                  const lastMsg = item.messages[item.messages.length - 1];

                  // Check if next item starts a new sender group (determines bottom margin)
                  const nextFirstMessage = nextItem
                    ? getFirstMessageOfItem(nextItem)
                    : null;
                  const isLastInGroup =
                    !nextFirstMessage ||
                    nextFirstMessage.sender !== lastMsg.sender ||
                    nextFirstMessage.senderType !== lastMsg.senderType ||
                    new Date(nextFirstMessage.timestamp).getTime() -
                      new Date(lastMsg.timestamp).getTime() >
                      20 * 60 * 1000;

                  // Within a group: small margin. End of group: large margin. Last item: no margin.
                  const marginClass = isLastItem
                    ? "mb-0"
                    : isLastInGroup
                      ? "mb-8"
                      : "mb-1";

                  return (
                    <div
                      key={`tool-group-${firstMsg.id}`}
                      data-message-id={firstMsg.id}
                      className={marginClass}
                    >
                      <ToolGroup
                        messages={item.messages}
                        firehoseMode={firehoseMode}
                      />
                    </div>
                  );
                }

                // Regular message
                const message = item.message;

                // Check if this message should show the header
                // Show header if: first message, different sender from previous, or >20 min gap
                const showHeader =
                  !prevLastMessage ||
                  prevLastMessage.sender !== message.sender ||
                  prevLastMessage.senderType !== message.senderType ||
                  new Date(message.timestamp).getTime() -
                    new Date(prevLastMessage.timestamp).getTime() >
                    20 * 60 * 1000;

                // Check if next item starts a new sender group (determines bottom margin)
                const nextFirstMessage = nextItem
                  ? getFirstMessageOfItem(nextItem)
                  : null;
                const isLastInGroup =
                  !nextFirstMessage ||
                  nextFirstMessage.sender !== message.sender ||
                  nextFirstMessage.senderType !== message.senderType ||
                  new Date(nextFirstMessage.timestamp).getTime() -
                    new Date(message.timestamp).getTime() >
                    20 * 60 * 1000;

                // Within a group: small margin. End of group: large margin. Last item: no margin.
                const marginClass = isLastItem
                  ? "mb-0"
                  : isLastInGroup
                    ? "mb-8"
                    : "mb-1";

                return (
                  <div
                    key={message.id}
                    data-message-id={message.id}
                    className={marginClass}
                  >
                    <MessageItem
                      message={message}
                      threadName={threadName}
                      myName={myName}
                      apiHost={apiHost}
                      artifacts={artifactMap}
                      agentType={
                        message.sender
                          ? agentTypeMap.get(message.sender)
                          : threadAgentType
                      }
                      channelId={channelId}
                      spaceId={spaceId}
                      roster={roster}
                      rosterIndex={
                        message.sender
                          ? rosterIndexMap.get(message.sender)
                          : undefined
                      }
                      onStructuredAskSubmit={onStructuredAskSubmit}
                      onStructuredAskCancel={onStructuredAskCancel}
                      showHeader={showHeader}
                    />
                  </div>
                );
              });
            })()}
          </>
        )}
      </div>
    </div>
  );
}

interface MessageItemProps {
  message: Message;
  threadName?: string;
  myName?: string;
  /** API host for attachment URLs */
  apiHost?: string;
  /** Artifact map for [[slug]] title lookup */
  artifacts?: Map<string, ArtifactInfo>;
  /** Agent type for cartouche color scheme */
  agentType?: string;
  /** Channel ID for Cartouche color shuffling */
  channelId?: string;
  /** Space ID for runtime lookup */
  spaceId?: string;
  /** Roster for runtime lookup */
  roster?: RosterAgent[];
  /** Roster index for Cartouche color assignment */
  rosterIndex?: number;
  onStructuredAskSubmit?: (
    messageId: string,
    response: Record<string, unknown>,
  ) => void;
  /** Callback when user cancels/dismisses a structured ask */
  onStructuredAskCancel?: (messageId: string) => void;
  /** Whether to show the header (glyph, name, timestamp). False for consecutive messages from same sender. */
  showHeader?: boolean;
}

/**
 * Format timestamp for display:
 * - Today: just time (e.g., "2:30 PM")
 * - Yesterday: "Yesterday at 2:30 PM"
 * - This week: day name + time (e.g., "Monday at 2:30 PM")
 * - This year: month + day + time (e.g., "Jan 5 at 2:30 PM")
 * - Older: full date (e.g., "Jan 5, 2024 at 2:30 PM")
 */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);

  if (isToday(date)) {
    return format(date, "h:mm a");
  }
  if (isYesterday(date)) {
    return `Yesterday at ${format(date, "h:mm a")}`;
  }
  if (isThisWeek(date)) {
    return format(date, "EEEE 'at' h:mm a");
  }
  if (isThisYear(date)) {
    return format(date, "MMM d 'at' h:mm a");
  }
  return format(date, "MMM d, yyyy 'at' h:mm a");
}

/**
 * Represents either a single message or a group of consecutive tool messages.
 */
type MessageOrGroup =
  | { type: "message"; message: Message; index: number }
  | { type: "tool_group"; messages: Message[]; startIndex: number };

/**
 * Group consecutive tool_call messages (by ULID order) with their results.
 *
 * Logic:
 * - Only tool_call messages define groups (consecutive calls = one group)
 * - tool_result messages are collected separately and passed to ToolGroup for pairing
 * - Any non-tool message breaks the group
 * - This preserves interleaving: text → [tool group] → text → [tool group]
 */
function groupMessages(messages: Message[]): MessageOrGroup[] {
  const result: MessageOrGroup[] = [];

  // Filter out send_message and set_status tool calls (redundant - they echo into the thread)
  // Also filter out event messages (system nudges not meant for user display)
  const filteredMessages = messages.filter((msg) => {
    // Hide event messages from the chat UI
    if (msg.type === "event") {
      return false;
    }
    if (
      msg.type === "tool_call" &&
      (msg.toolName === "mcp__miriad__send_message" ||
        msg.toolName === "mcp__miriad__set_status")
    ) {
      return false;
    }
    // Also filter out the corresponding results
    if (msg.type === "tool_result") {
      const callMsg = messages.find(
        (m) =>
          m.type === "tool_call" &&
          (m.toolCallId === msg.toolResultCallId ||
            m.id === msg.toolResultCallId),
      );
      if (
        callMsg?.toolName === "mcp__miriad__send_message" ||
        callMsg?.toolName === "mcp__miriad__set_status"
      ) {
        return false;
      }
    }
    return true;
  });

  // First pass: collect all tool_results by their call ID for lookup
  const resultsByCallId = new Map<string, Message>();
  for (const msg of filteredMessages) {
    if (msg.type === "tool_result" && msg.toolResultCallId) {
      resultsByCallId.set(msg.toolResultCallId, msg);
    }
  }

  let i = 0;
  while (i < filteredMessages.length) {
    const msg = filteredMessages[i];

    // Skip tool_result messages - they get paired with their calls
    if (msg.type === "tool_result") {
      i++;
      continue;
    }

    // Check if this is a tool_call message
    if (msg.type === "tool_call") {
      // Collect consecutive tool_call messages
      const toolCalls: Message[] = [msg];
      let j = i + 1;

      while (j < filteredMessages.length) {
        const nextMsg = filteredMessages[j];
        // Skip tool_results when looking for consecutive calls
        if (nextMsg.type === "tool_result") {
          j++;
          continue;
        }
        // Group consecutive tool_calls
        if (nextMsg.type === "tool_call") {
          toolCalls.push(nextMsg);
          j++;
        } else {
          // Any other message type breaks the group
          break;
        }
      }

      // Build the group with calls and their matched results
      const groupMessages: Message[] = [];
      for (const call of toolCalls) {
        groupMessages.push(call);
        const callId = call.toolCallId || call.id;
        const result = resultsByCallId.get(callId);
        if (result) {
          groupMessages.push(result);
        }
      }

      result.push({
        type: "tool_group",
        messages: groupMessages,
        startIndex: i,
      });
      i = j;
    } else {
      result.push({ type: "message", message: msg, index: i });
      i++;
    }
  }

  return result;
}

function MessageItem({
  message,
  threadName = "Agent",
  myName = "",
  apiHost = "",
  artifacts,
  agentType,
  channelId = "",
  spaceId,
  roster = [],
  rosterIndex = 0,
  onStructuredAskSubmit,
  onStructuredAskCancel,
  showHeader = true,
}: MessageItemProps) {
  const isDarkMode = useIsDarkMode();
  const isUser = message.senderType === "user";
  const hasAttachments =
    message.attachmentSlugs && message.attachmentSlugs.length > 0;

  // Contextual messages: agent messages not sent via send_message (thinking out loud)
  const isContextual =
    message.senderType === "agent" && message.method !== "send_message";

  // Get display name: use sender if available, fallback to myName/threadName
  const displayName =
    message.sender && message.sender !== "agent"
      ? message.sender
      : isUser
        ? myName || "You"
        : threadName;

  // Special handling for structured_ask messages
  // Content contains: { prompt, fields, submitLabel, formState, response?, respondedBy?, respondedAt? }
  const contentObj =
    message.type === "structured_ask" &&
    message.content &&
    typeof message.content === "object"
      ? (message.content as Record<string, unknown>)
      : null;
  const hasFormFields =
    contentObj && "fields" in contentObj && "prompt" in contentObj;

  if (message.type === "structured_ask" && hasFormFields) {
    // Transform to StructuredAskMessage shape expected by the form component
    // The content object IS the form data (prompt, fields, etc.)
    const structuredAskMessage: StructuredAskMessage = {
      id: message.id,
      channelId: message.channelId,
      type: "structured_ask",
      sender: message.sender,
      timestamp: message.timestamp,
      content: typeof contentObj.prompt === "string" ? contentObj.prompt : "",
      formData: {
        prompt: contentObj.prompt as string,
        fields: contentObj.fields as StructuredAskMessage["formData"]["fields"],
        submitLabel: contentObj.submitLabel as string | undefined,
        cancelLabel: contentObj.cancelLabel as string | undefined,
      },
      formState:
        (contentObj.formState as StructuredAskMessage["formState"]) ||
        "pending",
      response: contentObj.response as StructuredAskMessage["response"],
      respondedBy: contentObj.respondedBy as string | undefined,
      respondedAt: contentObj.respondedAt as string | undefined,
      dismissedBy: contentObj.dismissedBy as string | undefined,
      dismissedAt: contentObj.dismissedAt as string | undefined,
    };

    return (
      <div className="flex flex-col min-w-0 max-w-[90%] relative">
        {showHeader && (
          <MessageHeader
            name={message.sender || displayName}
            displayName={displayName}
            agentType={agentType}
            timestamp={message.timestamp}
            channelId={channelId}
            rosterIndex={rosterIndex}
            isHuman={isUser}
          />
        )}
        <StructuredAskForm
          message={structuredAskMessage}
          onSubmit={onStructuredAskSubmit || (() => {})}
          onCancel={onStructuredAskCancel}
          spaceId={spaceId}
          apiHost={apiHost}
          roster={roster}
        />
      </div>
    );
  }

  // Note: tool_call and tool_result messages are handled by ToolGroup
  // in the parent render loop, so they won't reach this component

  // Helper to extract text content (may be string, { text: "..." }, or { status: "..." } object)
  const getTextContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
      if ("text" in content) {
        return (content as { text: string }).text;
      }
      if ("status" in content) {
        return (content as { status: string }).status;
      }
    }
    return "";
  };

  // Error messages
  if (message.type === "error") {
    return (
      <div className="flex items-center gap-2 text-base text-destructive bg-destructive/10 px-3 py-2 rounded-md">
        <AlertCircle size={14} className="flex-shrink-0" />
        <span>
          {highlightMentions(getTextContent(message.content), {
            myName,
            artifacts,
          })}
        </span>
      </div>
    );
  }

  // Status messages (including agent lifecycle events and agent status updates)
  if (message.type === "status") {
    // Enforce: structured content must be an object, never JSON-stringified
    if (
      typeof message.content === "string" &&
      message.content.startsWith("{")
    ) {
      throw new Error(
        `Status message has JSON-stringified content - this is a bug. Content: ${message.content}`,
      );
    }

    // Extract structured content if present
    const statusContent =
      typeof message.content === "object" && message.content !== null
        ? (message.content as { action?: string; callsign?: string })
        : null;

    // Render summon action with coffee icon
    if (statusContent?.action === "summon" && statusContent.callsign) {
      return (
        <div className="flex items-center gap-2 text-base text-muted-foreground px-3 py-2">
          <Coffee size={14} className="flex-shrink-0" />
          <span>
            Summoned{" "}
            <span className="font-medium">{statusContent.callsign}</span>
          </span>
        </div>
      );
    }

    // Render dismiss action with bed icon
    if (statusContent?.action === "dismiss" && statusContent.callsign) {
      return (
        <div className="flex items-center gap-2 text-base text-muted-foreground px-3 py-2">
          <Bed size={14} className="flex-shrink-0" />
          <span>
            <span className="font-medium">{statusContent.callsign}</span> has
            been dismissed
          </span>
        </div>
      );
    }

    // Agent status updates (from set_status) - show with header like regular messages
    if (message.senderType === "agent") {
      const statusText = getTextContent(message.content);
      return (
        <div className="flex flex-col min-w-0 group relative">
          {showHeader && (
            <MessageHeader
              name={message.sender || displayName}
              displayName={displayName}
              agentType={agentType}
              timestamp={message.timestamp}
              channelId={channelId}
              rosterIndex={rosterIndex}
              isHuman={false}
            />
          )}
          <div className="flex items-center gap-1.5 text-base text-[var(--cast-text-muted)]">
            <ArrowRight size={14} className="flex-shrink-0" />
            <span>{statusText}</span>
          </div>
        </div>
      );
    }

    // Fallback for plain text status messages (system messages)
    return (
      <div className="flex items-center gap-2 text-base text-muted-foreground px-3 py-2">
        <CirclePlus size={14} className="flex-shrink-0" />
        <span>
          {highlightMentions(getTextContent(message.content), {
            myName,
            artifacts,
          })}
        </span>
      </div>
    );
  }

  // Attachment messages - display file with optional title/description
  if (message.type === "attachment" && apiHost) {
    // Parse content as attachment data (may be string or object)
    let attachmentData: AttachmentMessageContent | null = null;
    try {
      if (
        typeof message.content === "string" &&
        message.content.startsWith("{")
      ) {
        attachmentData = JSON.parse(
          message.content,
        ) as AttachmentMessageContent;
      } else if (
        typeof message.content === "object" &&
        message.content !== null
      ) {
        attachmentData = message.content as unknown as AttachmentMessageContent;
      }
    } catch {
      // Fall through to show error
    }

    if (!attachmentData) {
      return (
        <div className="flex items-center gap-2 text-base text-destructive bg-destructive/10 px-3 py-2 rounded-md">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span>Invalid attachment data</span>
        </div>
      );
    }

    // Extract slug from URL (last path segment) for asset rendering
    const slug = attachmentData.url.split("/").pop() || attachmentData.filename;

    return (
      <div className="flex flex-col min-w-0 max-w-[80%] relative">
        {showHeader && (
          <MessageHeader
            name={message.sender || displayName}
            displayName={displayName}
            agentType={agentType}
            timestamp={message.timestamp}
            channelId={channelId}
            rosterIndex={rosterIndex}
            isHuman={isUser}
          />
        )}
        <div className="bg-card border border-border overflow-hidden">
          {/* Title - show prominently if provided */}
          {attachmentData.title && (
            <div className="px-3 py-2 border-b border-border bg-secondary/30">
              <div className="font-medium text-base">
                {attachmentData.title}
              </div>
            </div>
          )}
          {/* Attachment preview */}
          <div className="p-3">
            <AssetRenderer
              slug={slug}
              channelId={message.channelId}
              apiHost={apiHost}
              compact={false}
            />
          </div>
          {/* Description - show below if provided */}
          {attachmentData.description && (
            <div className="px-3 py-2 border-t border-border bg-secondary/20">
              <p className="text-base text-muted-foreground">
                {attachmentData.description}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Get raw content for copy
  const rawContent =
    typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text || "";

  // Regular user/assistant messages
  return (
    <div className="flex flex-col min-w-0 group relative">
      {showHeader && (
        <MessageHeader
          name={message.sender || displayName}
          displayName={displayName}
          agentType={agentType}
          timestamp={message.timestamp}
          channelId={channelId}
          rosterIndex={rosterIndex}
          isHuman={isUser}
          menuContent={rawContent}
        />
      )}
      <div className="message-content">
        {renderMessageContent(
          message,
          myName,
          artifacts,
          isDarkMode,
          isContextual,
        )}
      </div>
      {/* Render attachments below the message */}
      {hasAttachments && apiHost && (
        <MessageAttachments
          slugs={message.attachmentSlugs!}
          channelId={message.channelId}
          apiHost={apiHost}
          compact
          className="mt-2"
        />
      )}
    </div>
  );
}

/**
 * Create markdown components that highlight @mentions and [[slug]] links.
 */
function createMarkdownComponents(
  myName: string,
  artifacts?: Map<string, ArtifactInfo>,
  isDarkMode?: boolean,
): Components {
  // Process children to highlight @mentions and [[slug]] links in text nodes
  const processChildren = (children: React.ReactNode): React.ReactNode => {
    if (typeof children === "string") {
      return highlightMentions(children, { myName, artifacts });
    }
    if (Array.isArray(children)) {
      return children.map((child, i) => {
        if (typeof child === "string") {
          return (
            <span key={i}>
              {highlightMentions(child, { myName, artifacts })}
            </span>
          );
        }
        return child;
      });
    }
    return children;
  };

  // Select syntax highlighting theme based on mode
  const codeTheme = isDarkMode ? oneDark : oneLight;

  return {
    // Override text rendering to highlight @mentions and [[slug]] links
    p: ({ children }) => <p>{processChildren(children)}</p>,
    li: ({ children }) => <li>{processChildren(children)}</li>,
    td: ({ children }) => <td>{processChildren(children)}</td>,
    th: ({ children }) => <th>{processChildren(children)}</th>,
    // Syntax highlighting for code blocks
    code: ({ className, children, node, ...props }) => {
      const match = /language-(\w+)/.exec(className || "");
      // Check if this is a code block: has language class, or parent is pre (node check), or has newlines
      const codeString = String(children);
      const hasNewlines = codeString.includes("\n");
      const isCodeBlock = match || hasNewlines;

      if (!isCodeBlock) {
        // Inline code - render as styled span
        return (
          <code
            className="bg-secondary px-1.5 py-0.5 text-base font-mono rounded"
            {...props}
          >
            {children}
          </code>
        );
      }

      // Code block - use syntax highlighter with copy button
      const language = match ? match[1] : "text";
      const codeContent = codeString.replace(/\n$/, "");
      return (
        <div className="not-prose relative group/code">
          <CopyButton
            text={codeContent}
            className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 bg-secondary/90"
          />
          <SyntaxHighlighter
            style={codeTheme}
            language={language}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: "1rem",
              fontSize: "13px",
              lineHeight: "1.2",
              borderRadius: "0.25rem",
            }}
          >
            {codeContent}
          </SyntaxHighlighter>
        </div>
      );
    },
    // Override pre to avoid double wrapping
    pre: ({ children }) => <>{children}</>,
  };
}

function renderMessageContent(
  message: Message,
  myName: string = "",
  artifacts?: Map<string, ArtifactInfo>,
  isDarkMode: boolean = false,
  isContextual: boolean = false,
): React.ReactNode {
  // Handle content that may be a string or { text: "..." } object
  const content =
    typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string })?.text || "";

  // Create markdown components with myName for @mention highlighting and artifacts for [[slug]] lookup
  const markdownComponents = createMarkdownComponents(
    myName,
    artifacts,
    isDarkMode,
  );

  // Base prose classes
  const proseClasses =
    "prose prose-base dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";
  // For contextual messages, override prose text color to muted
  const contextualClasses = isContextual
    ? "[&_*]:!text-[var(--cast-text-muted)]"
    : "";

  // For user/assistant/thinking messages, render markdown
  return (
    <Markdown
      className={`${proseClasses} ${contextualClasses}`}
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
    >
      {content}
    </Markdown>
  );
}
