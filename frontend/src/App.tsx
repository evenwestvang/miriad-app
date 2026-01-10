import { useState, useEffect, useCallback, useMemo } from "react";
import {
  PanelLeft,
  PanelLeftClose,
  LogOut,
  Sun,
  Moon,
  Settings,
} from "lucide-react";
import {
  ThreadList,
  type ThreadWithState,
} from "./components/sidebar/ThreadList";
import { BoardPanel } from "./components/board";
import { ChannelList } from "./components/channel/ChannelList";
import { MessageList } from "./components/channel/MessageList";
import { MessageInput } from "./components/channel/MessageInput";
import { AgentRoster, type AgentType } from "./components/channel/AgentRoster";
import { AgentDetailPanel } from "./components/channel/AgentDetailPanel";
import { ChatHeader } from "./components/channel/ChatHeader";
import {
  useTymbalConnection,
  type ArtifactEvent,
  type RosterEvent,
  type RosterStateEvent,
  type CostInfo,
} from "./hooks/useTymbalConnection";
import { useUrlState } from "./hooks/useUrlState";
import { useTheme } from "./hooks/useTheme";
import { EmptyStateChannelCreation } from "./components/focus";
import { cn } from "./lib/utils";
import {
  API_HOST,
  apiFetch,
  checkAuth,
  logout,
  type AuthSession,
} from "./lib/api";
import { LoginPage } from "./components/LoginPage";
import { OnboardingPage } from "./components/OnboardingPage";
import { AuthErrorPage } from "./components/AuthErrorPage";
import { OAuthCallbackPage } from "./components/OAuthCallbackPage";
import { OAuthErrorPage } from "./components/OAuthErrorPage";
import { SettingsModal } from "./components/settings";

// Auth mode: 'dev' (show LoginPage) or 'workos' (redirect to /auth/login)
const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || "dev";
import type { Agent, Channel, Message } from "./types";
import type { RosterAgent } from "./components/channel/MentionAutocomplete";

export function App() {
  // Check for OAuth popup pages first (before any state initialization)
  // These are loaded in popups and should render immediately without the full app
  const pathname = window.location.pathname;
  const searchParams = new URLSearchParams(window.location.search);

  // OAuth error page: /oauth-error?error=...&description=...
  if (pathname === "/oauth-error") {
    return <OAuthErrorPage />;
  }

  // OAuth success callback: any path with ?app=...&connected=true
  // Backend redirects to /spaces/{spaceId}/channels/{channelId}?app={slug}&connected=true
  if (searchParams.get("connected") === "true" && searchParams.get("app")) {
    return <OAuthCallbackPage />;
  }

  // Auth state
  const [authSession, setAuthSession] = useState<
    AuthSession | null | undefined
  >(undefined); // undefined = checking

  // Onboarding state (for new WorkOS users)
  const [onboardingToken, setOnboardingToken] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState<string | undefined>(
    undefined,
  );

  // Auth error state (for OAuth errors)
  const [authError, setAuthError] = useState<string | null>(null);

  // URL-based routing state
  const {
    state: urlState,
    navigateToChannel,
    toggleBoard,
    closeBoard,
    focusArtifact,
    clearArtifactFocus,
  } = useUrlState();

  // Derive state from URL
  const selectedThread = urlState.channelId;
  const boardOpen = urlState.sidebarMode === "board";

  // Theme state
  const { theme, toggleTheme } = useTheme();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [threads, setThreads] = useState<ThreadWithState[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [channels] = useState<Channel[]>([]); // Placeholder for phase 2
  // Message cache: Map<channelId, Message[]> - persists across channel switches
  // Uses Map insertion order for LRU eviction (max 10 channels)
  const [messageCache, setMessageCache] = useState<Map<string, Message[]>>(
    new Map(),
  );
  const MESSAGE_CACHE_LIMIT = 10;
  // Derive current messages from cache
  const messages = selectedThread ? messageCache.get(selectedThread) || [] : [];
  // Get current user from auth session
  const currentUser = authSession?.user.callsign || "user";
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  // Track which agents are "working" (sent messages but no idle frame yet)
  const [workingAgents, setWorkingAgents] = useState<Set<string>>(new Set());
  const [leader, setLeader] = useState<string | undefined>(undefined);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [_isStartingWorkspace, setIsStartingWorkspace] = useState(false);
  // Track channel switching to show loading instead of empty state
  const [isSwitchingChannel, setIsSwitchingChannel] = useState(false);
  // Delayed spinner - only show after 500ms to avoid flash on fast loads
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem("sidebar-open");
    return stored !== null ? JSON.parse(stored) : true;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Artifact event counter - increment to trigger board refresh
  const [artifactEventTrigger, setArtifactEventTrigger] = useState(0);
  // Selected agent for detail panel (callsign or null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // Summon picker open state (controlled from MessageInput button)
  const [summonOpen, setSummonOpen] = useState(false);
  // Recently dismissed agents (for warning when mentioning them)
  const [dismissedAgents, setDismissedAgents] = useState<Set<string>>(new Set());

  // Check authentication on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Check for auth error in URL (OAuth errors redirect here)
    const error = params.get("error");
    if (error || window.location.pathname === "/auth-error") {
      setAuthError(error || "unknown");
      // Clear URL params but keep path for bookmarking
      window.history.replaceState({}, "", "/");
      return;
    }

    // Check for onboarding token in URL (new WorkOS users)
    const token = params.get("token");
    const name = params.get("name");

    if (token) {
      // New user needs onboarding
      setOnboardingToken(token);
      setSuggestedName(name || undefined);
      // Clear URL params
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    checkAuth().then((session) => {
      if (session) {
        setAuthSession(session);
      } else if (AUTH_MODE === "workos") {
        // In prod mode, redirect to backend login endpoint
        window.location.href = `${API_HOST}/auth/login`;
      } else {
        // In dev mode, show login page
        setAuthSession(null);
      }
    });
  }, []);

  // Handle successful login
  const handleLogin = () => {
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session);
    });
  };

  // Handle onboarding completion
  const handleOnboardingComplete = () => {
    setOnboardingToken(null);
    setSuggestedName(undefined);
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session);
    });
  };

  // Get the current thread's agent name for display
  const currentThread = threads.find((t) => t.id === selectedThread);

  // Message handlers - memoized to prevent reconnections
  const handleMessage = useCallback((msg: Message) => {
    // Handle container lifecycle status messages
    if (msg.type === "status") {
      if (msg.content === "container_starting") {
        setIsStartingWorkspace(true);
        return; // Don't add to message list
      }
      if (msg.content === "container_ready") {
        setIsStartingWorkspace(false);
        return; // Don't add to message list
      }
      if (msg.content === "container_error") {
        setIsStartingWorkspace(false);
        // Let the error message through to display in the message list
      }
    }

    // Regular message - add to cache for this channel
    // Clear switching state as soon as first message arrives
    setIsSwitchingChannel((wasSwitching) => {
      if (wasSwitching) {
        console.log(
          `[ChannelSwitch] First message arrived at ${performance.now().toFixed(2)}ms (id: ${msg.id})`,
        );
      }
      return false;
    });
    setMessageCache((cache) => {
      const channelId = msg.channelId;
      const existing = cache.get(channelId) || [];
      // Merge by ULID: update existing or add new, then sort by ULID
      const messageMap = new Map(existing.map((m) => [m.id, m]));
      messageMap.set(msg.id, msg);
      // ULIDs are lexicographically sortable (chronological order)
      const updated = Array.from(messageMap.values()).sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      // Build new cache, maintaining insertion order for FIFO eviction
      const newCache = new Map(cache);
      // Delete and re-add to move to end (most recent)
      newCache.delete(channelId);
      newCache.set(channelId, updated);

      // Evict least recently used channels if over limit (LRU)
      // Map maintains insertion order, so first key is least recently accessed
      while (newCache.size > MESSAGE_CACHE_LIMIT) {
        const lruKey = newCache.keys().next().value;
        if (lruKey) {
          console.log(`[MessageCache] Evicting LRU channel: ${lruKey}`);
          newCache.delete(lruKey);
        }
      }

      return newCache;
    });

    // Any agent/tool response means container is ready
    if (msg.type === "agent" || msg.type === "tool_call") {
      setIsStartingWorkspace(false);
    }

    // Mark agent as "working" when they send a message (will clear on idle frame)
    if (msg.senderType === "agent" && msg.sender) {
      setWorkingAgents((prev) => {
        if (prev.has(msg.sender)) return prev;
        const next = new Set(prev);
        next.add(msg.sender);
        return next;
      });
    }
  }, []);

  const handleMessageUpdate = useCallback((id: string, content: string) => {
    setMessageCache((cache) => {
      // Find which channel has this message
      for (const [channelId, msgs] of cache.entries()) {
        const idx = msgs.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const updated = [...msgs];
          updated[idx] = { ...updated[idx], content };
          const newCache = new Map(cache);
          newCache.set(channelId, updated);
          return newCache;
        }
      }
      return cache;
    });
  }, []);

  // Artifact event handler - triggers board refresh
  const handleArtifactEvent = useCallback((event: ArtifactEvent) => {
    console.log("Artifact event received:", event.action, event.artifact.slug);
    // Increment trigger to cause BoardPanel to refetch
    setArtifactEventTrigger((prev) => prev + 1);
  }, []);

  // Roster event handler - real-time roster updates
  const handleRosterEvent = useCallback((event: RosterEvent) => {
    console.log("Roster event received:", event.action, event.agent.callsign);
    if (event.action === "agent_joined") {
      // Add agent to roster
      setRoster((prev) => {
        // Avoid duplicates
        if (prev.some((a) => a.callsign === event.agent.callsign)) {
          return prev;
        }
        return [
          ...prev,
          {
            callsign: event.agent.callsign,
            isOnline: event.agent.status === "idle", // idle means container is ready
          },
        ];
      });
    } else if (event.action === "agent_dismissed") {
      // Remove agent from roster
      setRoster((prev) =>
        prev.filter((a) => a.callsign !== event.agent.callsign),
      );
      // Also clear working state for dismissed agent
      setWorkingAgents((prev) => {
        if (!prev.has(event.agent.callsign)) return prev;
        const next = new Set(prev);
        next.delete(event.agent.callsign);
        return next;
      });
    }
  }, []);

  // Agent idle handler - clears working state when agent finishes turn
  const handleAgentIdle = useCallback((sender: string) => {
    setWorkingAgents((prev) => {
      if (!prev.has(sender)) return prev;
      const next = new Set(prev);
      next.delete(sender);
      return next;
    });
  }, []);

  // Cost frame handler - accumulates session cost per agent
  const handleCostFrame = useCallback((callsign: string, cost: CostInfo) => {
    setRoster((prev) => {
      const idx = prev.findIndex((a) => a.callsign === callsign);
      if (idx === -1) return prev; // Agent not in roster
      const updated = [...prev];
      const agent = updated[idx];
      updated[idx] = {
        ...agent,
        sessionCost: (agent.sessionCost || 0) + cost.totalCostUsd,
      };
      return updated;
    });
  }, []);

  // Roster state event handler - updates agent online/offline/connecting state in real-time
  // Tracks lastHeartbeat for client-side offline timeout (60s threshold)
  const handleRosterStateEvent = useCallback((event: RosterStateEvent) => {
    console.log(
      "Roster state event:",
      event.callsign,
      event.state,
      event.lastHeartbeat,
    );
    // Close detail panel if dismissed agent was selected (via broadcast from another client)
    if (event.state === "dismissed") {
      setSelectedAgent((current) =>
        current === event.callsign ? null : current,
      );
      // Track dismissed agent for warning when user @mentions them
      setDismissedAgents((prev) => {
        const next = new Set(prev);
        next.add(event.callsign);
        return next;
      });
    }

    setRoster((prev) => {
      // Dismissed state - remove agent from roster (archived on backend)
      if (event.state === "dismissed") {
        return prev.filter((a) => a.callsign !== event.callsign);
      }

      const idx = prev.findIndex((a) => a.callsign === event.callsign);
      if (idx === -1) {
        // Agent not in roster yet - might be joining, add them
        if (event.state === "connecting" || event.state === "online") {
          return [
            ...prev,
            {
              callsign: event.callsign,
              isOnline: event.state === "online",
              isConnecting: event.state === "connecting",
              lastHeartbeat: event.lastHeartbeat,
            },
          ];
        }
        return prev; // offline/paused for unknown agent, ignore
      }
      // Update existing agent
      // Paused/muted is independent of online/connecting - an agent can be online AND muted
      const updated = [...prev];
      if (event.state === "paused") {
        // Mute event - only set isPaused, preserve online/connecting state
        updated[idx] = {
          ...updated[idx],
          isPaused: true,
          lastHeartbeat: event.lastHeartbeat ?? updated[idx].lastHeartbeat,
        };
      } else if (event.state === "online") {
        // Online event clears muted state (this is how unmute/resume works)
        updated[idx] = {
          ...updated[idx],
          isOnline: true,
          isConnecting: false,
          isPaused: false,
          lastHeartbeat: event.lastHeartbeat ?? updated[idx].lastHeartbeat,
        };
      } else {
        // Offline/connecting - update lifecycle state but preserve muted flag
        updated[idx] = {
          ...updated[idx],
          isOnline: false,
          isConnecting: event.state === "connecting",
          // isPaused preserved - muted agent that goes offline stays muted
          lastHeartbeat: event.lastHeartbeat ?? updated[idx].lastHeartbeat,
        };
      }
      return updated;
    });
  }, []);

  // Sync complete handler - clears switching state when no messages
  const handleSyncComplete = useCallback(() => {
    setIsSwitchingChannel(false);
  }, []);

  // Client-side offline timeout - check every 15s for stale heartbeats (60s threshold)
  // Server broadcasts heartbeat timestamps, client handles offline detection locally
  // (Required because Lambda can't run persistent timers)
  useEffect(() => {
    const HEARTBEAT_STALE_MS = 60_000; // 60 seconds
    const CHECK_INTERVAL_MS = 15_000; // Check every 15 seconds

    const checkHeartbeats = () => {
      const now = Date.now();
      setRoster((prev) => {
        let changed = false;
        const updated = prev.map((agent) => {
          // Skip agents that are already offline or connecting
          if (!agent.isOnline || agent.isConnecting) return agent;
          // Skip agents without a heartbeat timestamp
          if (!agent.lastHeartbeat) return agent;

          const lastTime = new Date(agent.lastHeartbeat).getTime();
          const isStale = now - lastTime > HEARTBEAT_STALE_MS;

          if (isStale) {
            console.log(
              `[HeartbeatTimeout] Agent ${agent.callsign} is stale (last heartbeat: ${agent.lastHeartbeat})`,
            );
            changed = true;
            return { ...agent, isOnline: false, isConnecting: false };
          }
          return agent;
        });
        return changed ? updated : prev;
      });
    };

    const interval = setInterval(checkHeartbeats, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Delayed loading spinner - only show after 500ms to avoid flash on fast loads
  useEffect(() => {
    if (isSwitchingChannel) {
      const timer = setTimeout(() => {
        setShowLoadingSpinner(true);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingSpinner(false);
    }
  }, [isSwitchingChannel]);

  // Get newest cached message timestamp for incremental sync
  const newestCachedTimestamp = selectedThread
    ? (() => {
        const cachedMsgs = messageCache.get(selectedThread);
        if (cachedMsgs && cachedMsgs.length > 0) {
          // Messages are sorted by ULID, last one is newest
          return cachedMsgs[cachedMsgs.length - 1].timestamp;
        }
        return undefined;
      })()
    : undefined;

  // Channel WebSocket connection for real-time streaming
  // Pass wsToken from auth session to avoid re-fetching on every channel switch
  const {
    connected,
    isWaitingForResponse,
    sendMessage,
    hasMoreMessages,
    isLoadingOlder,
    requestOlderMessages,
  } = useTymbalConnection({
    channelId: selectedThread,
    onMessage: handleMessage,
    onMessageUpdate: handleMessageUpdate,
    onArtifactEvent: handleArtifactEvent,
    onRosterEvent: handleRosterEvent,
    onRosterStateEvent: handleRosterStateEvent,
    onAgentIdle: handleAgentIdle,
    onCostFrame: handleCostFrame,
    onSyncComplete: handleSyncComplete,
    currentUser,
    wsToken: authSession?.wsToken,
    newestCachedTimestamp,
  });

  // Set default agents (local Cikada runtime doesn't have /agents endpoint)
  useEffect(() => {
    // Default agent for local development
    const defaultAgents = [
      {
        id: "claude-code",
        name: "Claude Code",
        description: "Agentic coding assistant with file and terminal access",
      },
    ];
    setAgents(defaultAgents);
    // Map to AgentType format for picker
    setAgentTypes(
      defaultAgents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
      })),
    );
    setAgentsLoading(false);
  }, []);

  // Fetch channels from API on mount
  useEffect(() => {
    async function fetchChannels() {
      try {
        const response = await apiFetch(`${API_HOST}/channels`);
        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status}`);
        }
        const data = await response.json();
        // Map API response to ThreadWithState interface
        // Channels API returns: { channels: [{ id, name, description, tagline, status, createdAt }] }
        const threadList: ThreadWithState[] = (data.channels || []).map(
          (c: {
            id: string;
            name: string;
            description?: string;
            tagline?: string;
            status?: string;
            createdAt: string;
          }) => ({
            id: c.id,
            agentId: c.id,
            agentName: c.name,
            agentType: "channel",
            agentState: c.status === "running" ? "thinking" : "idle",
            createdAt: c.createdAt,
          }),
        );
        setThreads(threadList);
      } catch (error) {
        console.error("Failed to fetch channels:", error);
        // Keep empty list on error
      } finally {
        setThreadsLoading(false);
      }
    }
    fetchChannels();
  }, []);

  // Handle thread/channel changes
  useEffect(() => {
    // Reset cold start state when changing threads
    setIsStartingWorkspace(false);

    // Don't clear messages - they're cached per channel
    // Only show switching state if we don't have cached messages for this channel
    setRoster([]);
    setLeader(undefined);
    // Clear agent selection on channel switch
    setSelectedAgent(null);
    // Clear dismissed agents tracking on channel switch
    setDismissedAgents(new Set());
    if (selectedThread) {
      // Check cache at the time of switch (not reactive to cache changes)
      setMessageCache((cache) => {
        const hasCachedMessages =
          cache.has(selectedThread) && cache.get(selectedThread)!.length > 0;
        if (!hasCachedMessages) {
          setIsSwitchingChannel(true);
          console.log(
            `[ChannelSwitch] Started switching to channel ${selectedThread} at ${performance.now().toFixed(2)}ms (no cache)`,
          );
          return cache; // Don't modify cache - no messages yet
        } else {
          console.log(
            `[ChannelSwitch] Switched to channel ${selectedThread} (cached ${cache.get(selectedThread)!.length} messages)`,
          );
          // Move to end of Map to mark as recently accessed (LRU)
          const messages = cache.get(selectedThread)!;
          const newCache = new Map(cache);
          newCache.delete(selectedThread);
          newCache.set(selectedThread, messages);
          return newCache;
        }
      });
    }

    // Note: Roster fetch moved to happen AFTER WebSocket connects (see below)
    // This prevents HTTP request from blocking WebSocket connection
  }, [selectedThread]);

  // Fetch roster and cost tally AFTER initial paint - delayed to not compete with message sync
  useEffect(() => {
    if (!selectedThread || !connected) return;

    const timeoutId = setTimeout(() => {
      async function fetchRosterAndCosts() {
        console.log(
          `[ChannelSwitch] Starting roster fetch at ${performance.now().toFixed(2)}ms`,
        );
        try {
          // Fetch roster and costs in parallel
          const [rosterResponse, costsResponse] = await Promise.all([
            apiFetch(`${API_HOST}/channels/${selectedThread}/roster`),
            apiFetch(`${API_HOST}/channels/${selectedThread}/costs`),
          ]);

          if (!rosterResponse.ok) {
            throw new Error(`Failed to fetch roster: ${rosterResponse.status}`);
          }
          const rosterData = await rosterResponse.json();

          // Parse costs response (may fail for new channels with no costs)
          let costsByCallsign = new Map<string, number>();
          if (costsResponse.ok) {
            const costsData = await costsResponse.json();
            if (costsData.tally && Array.isArray(costsData.tally)) {
              for (const t of costsData.tally) {
                costsByCallsign.set(t.callsign, t.totalCostUsd);
              }
            }
          }

          console.log(
            `[ChannelSwitch] Roster fetch complete at ${performance.now().toFixed(2)}ms`,
          );
          // Map backend RosterEntry to frontend RosterAgent format
          if (rosterData.roster && Array.isArray(rosterData.roster)) {
            const rosterAgents: RosterAgent[] = rosterData.roster.map(
              (r: {
                callsign: string;
                agentType: string;
                status: string;
                callbackUrl?: string;
                tunnelHash?: string;
                lastHeartbeat?: string;
              }) => ({
                callsign: r.callsign,
                // isOnline: requires fresh heartbeat (within 60s)
                isOnline: r.lastHeartbeat
                  ? Date.now() - new Date(r.lastHeartbeat).getTime() < 60000
                  : false,
                // Paused/muted status from API
                isPaused: r.status === "paused",
                // Tunnel hash for HTTP exposure
                tunnelHash: r.tunnelHash,
                // Agent type for visual identification
                agentType: r.agentType,
                // Last heartbeat for client-side timeout tracking
                lastHeartbeat: r.lastHeartbeat,
                // Initialize with persisted cost (if any)
                sessionCost: costsByCallsign.get(r.callsign) ?? 0,
              }),
            );
            setRoster(rosterAgents);
            // Clear working agents on channel switch (fresh start)
            setWorkingAgents(new Set());
          }
        } catch (error) {
          console.error("Failed to fetch roster:", error);
        }
      }
      fetchRosterAndCosts();
    }, 250); // Delay to not compete with initial message sync

    return () => clearTimeout(timeoutId);
  }, [selectedThread, connected]);

  // Update thread state based on isWaitingForResponse
  useEffect(() => {
    if (!selectedThread) return;
    setThreads((prev) =>
      prev.map((t) =>
        t.id === selectedThread
          ? { ...t, agentState: isWaitingForResponse ? "thinking" : "idle" }
          : t,
      ),
    );
  }, [selectedThread, isWaitingForResponse]);

  // Compute roster with isWorking state merged in
  const rosterWithWorkingState = useMemo(() => {
    return roster.map((agent) => ({
      ...agent,
      isWorking: workingAgents.has(agent.callsign),
    }));
  }, [roster, workingAgents]);

  // Sidebar toggle keyboard shortcut (Cmd+B / Ctrl+B)
  // Board toggle keyboard shortcut (Cmd+Shift+B / Ctrl+Shift+B)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        if (e.shiftKey) {
          toggleBoard();
        } else {
          setSidebarOpen((prev: boolean) => !prev);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleBoard]);

  // Persist sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem("sidebar-open", JSON.stringify(sidebarOpen));
  }, [sidebarOpen]);

  // Create a new channel (displayed as "thread" in UI) - legacy version
  const handleCreateThread = useCallback(
    async (agentId: string, name?: string) => {
      setIsCreatingThread(true);
      try {
        const response = await apiFetch(`${API_HOST}/channels`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name || agentId,
            description: `Channel for ${agentId}`,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to create channel: ${response.status}`);
        }

        const data = await response.json();
        const agent = agents.find((a) => a.id === agentId);
        const newThread: ThreadWithState = {
          id: data.channel.id,
          agentId: agentId,
          agentName: name || data.channel.name || agentId,
          agentType: agent?.name || agentId,
          agentState: "idle",
          createdAt: data.channel.createdAt || new Date().toISOString(),
        };

        setThreads((prev) => [...prev, newThread]);
        navigateToChannel(newThread.id);
      } catch (error) {
        console.error("Failed to create channel:", error);
      } finally {
        setIsCreatingThread(false);
      }
    },
    [agents, navigateToChannel],
  );

  // Create a new channel with focus area
  const handleCreateChannel = useCallback(
    async (name: string, focusSlug: string | null) => {
      setIsCreatingThread(true);
      try {
        const response = await apiFetch(`${API_HOST}/channels`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            focusSlug: focusSlug || undefined,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to create channel: ${response.status}`);
        }

        const data = await response.json();
        const newThread: ThreadWithState = {
          id: data.channel.id,
          agentId: data.channel.id,
          agentName: data.channel.name || name,
          agentType: focusSlug || "channel",
          agentState: "idle",
          createdAt: data.channel.createdAt || new Date().toISOString(),
        };

        setThreads((prev) => [...prev, newThread]);
        navigateToChannel(newThread.id);
      } catch (error) {
        console.error("Failed to create channel:", error);
        throw error; // Re-throw so modal can handle it
      } finally {
        setIsCreatingThread(false);
      }
    },
    [navigateToChannel],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      navigateToChannel(threadId);
    },
    [navigateToChannel],
  );

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!selectedThread) return;
      sendMessage(content);
    },
    [selectedThread, sendMessage],
  );

  // Placeholder for channel selection (phase 2)
  const handleSelectChannel = useCallback((id: string) => {
    console.log("Channel selection coming in phase 2:", id);
  }, []);

  // Handle agent added to roster
  const handleAgentAdded = useCallback((agent: RosterAgent) => {
    setRoster((prev) => [...prev, agent]);
  }, []);

  // Handle agent dismissed from roster
  const handleAgentDismiss = useCallback(
    async (callsign: string) => {
      if (!selectedThread) return;

      try {
        const response = await apiFetch(
          `${API_HOST}/channels/${selectedThread}/agents/${callsign}`,
          {
            method: "DELETE",
          },
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          console.error(
            "Failed to dismiss agent:",
            data.error || response.status,
          );
          return;
        }

        // Remove from local roster
        setRoster((prev) => prev.filter((a) => a.callsign !== callsign));
        // Close panel if dismissed agent was selected
        if (selectedAgent === callsign) {
          setSelectedAgent(null);
        }
      } catch (error) {
        console.error("Failed to dismiss agent:", error);
      }
    },
    [selectedThread, selectedAgent],
  );

  // Handle agent selected in roster (toggle behavior)
  const handleAgentSelect = useCallback((callsign: string) => {
    setSelectedAgent((prev) => (prev === callsign ? null : callsign));
  }, []);

  // Handle agent panel close
  const handleAgentPanelClose = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  // Get selected agent data from roster
  const selectedAgentData = selectedAgent
    ? rosterWithWorkingState.find((a) => a.callsign === selectedAgent)
    : null;

  // Get selected agent's roster index for color
  const selectedAgentIndex = selectedAgent
    ? rosterWithWorkingState.findIndex((a) => a.callsign === selectedAgent)
    : -1;

  // Show auth error page if there was an OAuth error
  if (authError) {
    const handleRetryAuth = () => {
      setAuthError(null);
      if (AUTH_MODE === "workos") {
        window.location.href = `${API_HOST}/auth/login`;
      }
    };
    return <AuthErrorPage error={authError} onRetry={handleRetryAuth} />;
  }

  // Show onboarding page for new WorkOS users
  if (onboardingToken) {
    return (
      <OnboardingPage
        suggestedName={suggestedName}
        onboardingToken={onboardingToken}
        onComplete={handleOnboardingComplete}
        apiHost={API_HOST}
      />
    );
  }

  // Show loading while checking auth
  if (authSession === undefined) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Show login page if not authenticated (dev mode only - prod redirects to /auth/login)
  if (authSession === null) {
    return <LoginPage onLogin={handleLogin} apiHost={API_HOST} />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Unified header - spans full width */}
      <header className="h-12 flex items-center gap-3 px-5 border-b border-border bg-card flex-shrink-0">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1.5 rounded hover:bg-secondary/50 transition-colors"
          title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
          ) : (
            <PanelLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </button>

        {/* Branding */}
        <span className="font-semibold text-[#FF6600] text-sm tracking-[0.05em]">
          CAST
        </span>

        {/* Channel name */}
        {selectedThread && (
          <>
            <span className="text-[#ccc]">—</span>
            <span className="font-medium text-foreground">
              #{currentThread?.agentName || "channel"}
            </span>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Connection status */}
        {selectedThread && (
          <span
            className={`text-xs ${connected ? "text-green-500" : "text-muted-foreground"}`}
          >
            {connected ? "● Connected" : "○ Disconnected"}
          </span>
        )}

        {/* Settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4 text-[var(--cast-text-muted)]" />
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] transition-colors"
          title={
            theme === "light" ? "Switch to dark mode" : "Switch to light mode"
          }
        >
          {theme === "light" ? (
            <Moon className="w-4 h-4 text-[var(--cast-text-muted)]" />
          ) : (
            <Sun className="w-4 h-4 text-[var(--cast-text-muted)]" />
          )}
        </button>

        {/* User display */}
        <span className="text-sm text-muted-foreground">@{currentUser}</span>

        {/* Logout */}
        <button
          onClick={logout}
          className="p-1.5 rounded hover:bg-secondary/50 transition-colors"
          title="Log out"
        >
          <LogOut className="w-4 h-4 text-muted-foreground" />
        </button>
      </header>

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={cn(
            "flex flex-col bg-card border-r border-border transition-all duration-200 overflow-hidden",
            sidebarOpen ? "w-[220px]" : "w-0 border-r-0",
          )}
        >
          <div className="flex-1 overflow-y-auto">
            <ThreadList
              threads={threads}
              agents={agents}
              selectedThread={selectedThread}
              isCreatingThread={isCreatingThread}
              onSelectThread={handleSelectThread}
              onCreateThread={handleCreateThread}
              onCreateChannel={handleCreateChannel}
              apiHost={API_HOST}
            />
            <ChannelList
              channels={channels}
              selected={null}
              onSelect={handleSelectChannel}
            />
          </div>
        </aside>

        {/* Main chat area */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-background overflow-hidden">
          {isCreatingThread ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">Creating thread...</p>
            </div>
          ) : selectedThread ? (
            <>
              {/* Chat panel header */}
              <ChatHeader
                isThinking={isWaitingForResponse}
                boardOpen={boardOpen}
                onToggleBoard={toggleBoard}
                channelCost={roster.reduce((sum, a) => sum + (a.sessionCost || 0), 0)}
              />
              <MessageList
                messages={messages}
                threadName={currentThread?.agentName}
                threadAgentType={currentThread?.agentType}
                apiHost={API_HOST}
                channelId={selectedThread || ""}
                roster={rosterWithWorkingState}
                isSwitching={isSwitchingChannel}
                isLoading={showLoadingSpinner}
                hasMoreMessages={hasMoreMessages}
                isLoadingOlder={isLoadingOlder}
                onRequestOlderMessages={requestOlderMessages}
              />
              {/* Input area with detail panel + roster bar above message input */}
              <div className="border-t border-border bg-card">
                {/* Agent detail panel - appears above roster when agent selected */}
                {selectedAgentData && selectedThread && (
                  <AgentDetailPanel
                    key="agent-detail-panel"
                    agent={selectedAgentData}
                    rosterIndex={selectedAgentIndex}
                    channelId={selectedThread}
                    apiHost={API_HOST}
                    onClose={handleAgentPanelClose}
                    onDismiss={handleAgentDismiss}
                  />
                )}
                {/* Roster bar - horizontal row, acts as tabs */}
                <div className="px-4 pt-3 pb-2">
                  <AgentRoster
                    roster={rosterWithWorkingState}
                    leader={leader}
                    agentTypes={agentTypes}
                    channelId={selectedThread || undefined}
                    apiHost={API_HOST}
                    onAgentAdded={handleAgentAdded}
                    onAgentDismiss={handleAgentDismiss}
                    onAgentSelect={handleAgentSelect}
                    selectedAgent={selectedAgent}
                    canManageAgents={!!selectedThread}
                    summonOpen={summonOpen}
                    onSummonClose={() => setSummonOpen(false)}
                  />
                </div>
                {/* Message input below roster */}
                <MessageInput
                  onSend={handleSendMessage}
                  disabled={!connected}
                  roster={rosterWithWorkingState}
                  channelId={selectedThread || undefined}
                  apiHost={API_HOST}
                  onSummon={() => setSummonOpen(true)}
                  resetKey={selectedThread}
                  dismissedAgents={dismissedAgents}
                />
              </div>
            </>
          ) : (
            <>
              {agentsLoading || threadsLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-muted-foreground">Loading...</p>
                </div>
              ) : (
                <EmptyStateChannelCreation
                  onCreate={handleCreateChannel}
                  apiHost={API_HOST}
                />
              )}
            </>
          )}
        </main>

        {/* Board panel */}
        <BoardPanel
          channelId={selectedThread}
          isOpen={boardOpen}
          onClose={closeBoard}
          apiHost={API_HOST}
          spaceId={authSession?.spaceId}
          refreshTrigger={artifactEventTrigger}
          selectedArtifact={urlState.artifactSlug}
          onSelectArtifact={focusArtifact}
          onClearSelection={clearArtifactFocus}
        />
      </div>

      {/* Settings modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiHost={API_HOST}
        spaceId={authSession?.spaceId}
      />
    </div>
  );
}
