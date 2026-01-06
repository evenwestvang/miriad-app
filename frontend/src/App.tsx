import { useState, useEffect, useCallback } from 'react'
import { PanelLeft, PanelLeftClose, LogOut, Sun, Moon } from 'lucide-react'
import { ThreadList, type ThreadWithState } from './components/sidebar/ThreadList'
import { BoardPanel } from './components/board'
import { ChannelList } from './components/channel/ChannelList'
import { MessageList } from './components/channel/MessageList'
import { MessageInput } from './components/channel/MessageInput'
import { AgentRoster, type AgentType } from './components/channel/AgentRoster'
import { ChatHeader } from './components/channel/ChatHeader'
import { useTymbalConnection, type ArtifactEvent, type RosterEvent } from './hooks/useTymbalConnection'
import { useUrlState } from './hooks/useUrlState'
import { useTheme } from './hooks/useTheme'
import { EmptyStateChannelCreation } from './components/focus'
import { cn } from './lib/utils'
import { API_HOST, apiFetch, checkAuth, logout, type AuthSession } from './lib/api'
import { LoginPage } from './components/LoginPage'
import { OnboardingPage } from './components/OnboardingPage'

// Auth mode: 'dev' (show LoginPage) or 'workos' (redirect to /auth/login)
const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || 'dev'
import type { Agent, Channel, Message } from './types'
import type { RosterAgent } from './components/channel/MentionAutocomplete'

export function App() {
  // Auth state
  const [authSession, setAuthSession] = useState<AuthSession | null | undefined>(undefined) // undefined = checking

  // Onboarding state (for new WorkOS users)
  const [onboardingToken, setOnboardingToken] = useState<string | null>(null)
  const [suggestedName, setSuggestedName] = useState<string | undefined>(undefined)

  // URL-based routing state
  const {
    state: urlState,
    navigateToChannel,
    toggleBoard,
    closeBoard,
    focusArtifact,
    clearArtifactFocus,
  } = useUrlState()

  // Derive state from URL
  const selectedThread = urlState.channelId
  const boardOpen = urlState.sidebarMode === 'board'

  // Theme state
  const { theme, toggleTheme } = useTheme()

  const [agents, setAgents] = useState<Agent[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [threads, setThreads] = useState<ThreadWithState[]>([])
  const [threadsLoading, setThreadsLoading] = useState(true)
  const [channels] = useState<Channel[]>([]) // Placeholder for phase 2
  const [messages, setMessages] = useState<Message[]>([])
  // Get current user from auth session
  const currentUser = authSession?.user.callsign || 'user'
  const [isCreatingThread, setIsCreatingThread] = useState(false)
  const [roster, setRoster] = useState<RosterAgent[]>([])
  const [leader, setLeader] = useState<string | undefined>(undefined)
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [isStartingWorkspace, setIsStartingWorkspace] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem('sidebar-open')
    return stored !== null ? JSON.parse(stored) : true
  })
  // Artifact event counter - increment to trigger board refresh
  const [artifactEventTrigger, setArtifactEventTrigger] = useState(0)

  // Check authentication on mount
  useEffect(() => {
    // Check for onboarding token in URL (new WorkOS users)
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const name = params.get('name')

    if (token) {
      // New user needs onboarding
      setOnboardingToken(token)
      setSuggestedName(name || undefined)
      // Clear URL params
      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    checkAuth().then((session) => {
      if (session) {
        setAuthSession(session)
      } else if (AUTH_MODE === 'workos') {
        // In prod mode, redirect to backend login endpoint
        window.location.href = `${API_HOST}/auth/login`
      } else {
        // In dev mode, show login page
        setAuthSession(null)
      }
    })
  }, [])

  // Handle successful login
  const handleLogin = () => {
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session)
    })
  }

  // Handle onboarding completion
  const handleOnboardingComplete = () => {
    setOnboardingToken(null)
    setSuggestedName(undefined)
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session)
    })
  }

  // Get the current thread's agent name for display
  const currentThread = threads.find(t => t.id === selectedThread)

  // Message handlers - memoized to prevent reconnections
  const handleMessage = useCallback((msg: Message) => {
    // Handle container lifecycle status messages
    if (msg.type === 'status') {
      if (msg.content === 'container_starting') {
        setIsStartingWorkspace(true)
        return // Don't add to message list
      }
      if (msg.content === 'container_ready') {
        setIsStartingWorkspace(false)
        return // Don't add to message list
      }
      if (msg.content === 'container_error') {
        setIsStartingWorkspace(false)
        // Let the error message through to display in the message list
      }
    }

    // Regular message - add to list
    setMessages((prev) => {
      // Avoid duplicates (sync might send messages we already have)
      if (prev.some((m) => m.id === msg.id)) {
        return prev.map((m) => (m.id === msg.id ? msg : m))
      }
      return [...prev, msg]
    })

    // Any agent/tool response means container is ready
    if (msg.type === 'agent' || msg.type === 'tool_call') {
      setIsStartingWorkspace(false)
    }
  }, [])

  const handleMessageUpdate = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m))
    )
  }, [])

  // Artifact event handler - triggers board refresh
  const handleArtifactEvent = useCallback((event: ArtifactEvent) => {
    console.log('Artifact event received:', event.action, event.artifact.slug)
    // Increment trigger to cause BoardPanel to refetch
    setArtifactEventTrigger(prev => prev + 1)
  }, [])

  // Roster event handler - real-time roster updates
  const handleRosterEvent = useCallback((event: RosterEvent) => {
    console.log('Roster event received:', event.action, event.agent.callsign)
    if (event.action === 'agent_joined') {
      // Add agent to roster
      setRoster(prev => {
        // Avoid duplicates
        if (prev.some(a => a.callsign === event.agent.callsign)) {
          return prev
        }
        return [...prev, {
          callsign: event.agent.callsign,
          status: (event.agent.status === 'idle' ? 'idle' : 'offline') as RosterAgent['status'],
        }]
      })
    } else if (event.action === 'agent_dismissed') {
      // Remove agent from roster
      setRoster(prev => prev.filter(a => a.callsign !== event.agent.callsign))
    }
  }, [])

  // Channel WebSocket connection for real-time streaming
  const { connected, isWaitingForResponse, sendMessage } = useTymbalConnection({
    channelId: selectedThread,
    onMessage: handleMessage,
    onMessageUpdate: handleMessageUpdate,
    onArtifactEvent: handleArtifactEvent,
    onRosterEvent: handleRosterEvent,
    currentUser,
  })

  // Set default agents (local Cikada runtime doesn't have /agents endpoint)
  useEffect(() => {
    // Default agent for local development
    const defaultAgents = [{
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Agentic coding assistant with file and terminal access',
    }]
    setAgents(defaultAgents)
    // Map to AgentType format for picker
    setAgentTypes(defaultAgents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
    })))
    setAgentsLoading(false)
  }, [])

  // Fetch channels from API on mount
  useEffect(() => {
    async function fetchChannels() {
      try {
        const response = await apiFetch(`${API_HOST}/channels`)
        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status}`)
        }
        const data = await response.json()
        // Map API response to ThreadWithState interface
        // Channels API returns: { channels: [{ id, name, description, tagline, status, createdAt }] }
        const threadList: ThreadWithState[] = (data.channels || []).map((c: {
          id: string
          name: string
          description?: string
          tagline?: string
          status?: string
          createdAt: string
        }) => ({
          id: c.id,
          agentId: c.id,
          agentName: c.name,
          agentType: 'channel',
          agentState: c.status === 'running' ? 'thinking' : 'idle',
          createdAt: c.createdAt,
        }))
        setThreads(threadList)
      } catch (error) {
        console.error('Failed to fetch channels:', error)
        // Keep empty list on error
      } finally {
        setThreadsLoading(false)
      }
    }
    fetchChannels()
  }, [])

  // Fetch thread details (including roster) and message history when thread changes
  useEffect(() => {
    // Reset cold start state when changing threads
    setIsStartingWorkspace(false)

    // Clear messages when channel changes - WebSocket sync will repopulate
    setMessages([])
    setRoster([])
    setLeader(undefined)

    if (!selectedThread) {
      return
    }

    // Fetch channel roster from separate endpoint
    async function fetchRoster() {
      try {
        const response = await apiFetch(`${API_HOST}/channels/${selectedThread}/roster`)
        if (!response.ok) {
          throw new Error(`Failed to fetch roster: ${response.status}`)
        }
        const data = await response.json()
        // Map backend RosterEntry to frontend RosterAgent format
        if (data.roster && Array.isArray(data.roster)) {
          const rosterAgents: RosterAgent[] = data.roster.map((r: {
            callsign: string
            agentType: string
            status: string
            callbackUrl?: string
          }) => ({
            callsign: r.callsign,
            // Map status based on callbackUrl presence (has container = idle, no container = offline)
            status: r.callbackUrl ? 'idle' : 'offline' as const,
          }))
          setRoster(rosterAgents)
        } else {
          setRoster([])
        }
        // Channel doesn't have a leader concept in local runtime
        setLeader(undefined)
      } catch (error) {
        console.error('Failed to fetch roster:', error)
        setRoster([])
        setLeader(undefined)
      }
    }

    // Fetch roster - message history comes via WebSocket sync
    fetchRoster()
    // Note: fetchMessageHistory() removed - WebSocket sync handles message replay
    // This eliminates the race condition between HTTP fetch and WebSocket sync
  }, [selectedThread, currentUser])

  // Update thread state based on isWaitingForResponse
  useEffect(() => {
    if (!selectedThread) return
    setThreads((prev) =>
      prev.map((t) =>
        t.id === selectedThread
          ? { ...t, agentState: isWaitingForResponse ? 'thinking' : 'idle' }
          : t
      )
    )
  }, [selectedThread, isWaitingForResponse])

  // Sidebar toggle keyboard shortcut (Cmd+B / Ctrl+B)
  // Board toggle keyboard shortcut (Cmd+Shift+B / Ctrl+Shift+B)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        if (e.shiftKey) {
          toggleBoard()
        } else {
          setSidebarOpen((prev: boolean) => !prev)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleBoard])

  // Persist sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('sidebar-open', JSON.stringify(sidebarOpen))
  }, [sidebarOpen])

  // Create a new channel (displayed as "thread" in UI) - legacy version
  const handleCreateThread = useCallback(async (agentId: string, name?: string) => {
    setIsCreatingThread(true)
    try {
      const response = await apiFetch(`${API_HOST}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || agentId, description: `Channel for ${agentId}` }),
      })

      if (!response.ok) {
        throw new Error(`Failed to create channel: ${response.status}`)
      }

      const data = await response.json()
      const agent = agents.find(a => a.id === agentId)
      const newThread: ThreadWithState = {
        id: data.channel.id,
        agentId: agentId,
        agentName: name || data.channel.name || agentId,
        agentType: agent?.name || agentId,
        agentState: 'idle',
        createdAt: data.channel.createdAt || new Date().toISOString(),
      }

      setThreads((prev) => [...prev, newThread])
      navigateToChannel(newThread.id)
    } catch (error) {
      console.error('Failed to create channel:', error)
    } finally {
      setIsCreatingThread(false)
    }
  }, [agents, navigateToChannel])

  // Create a new channel with focus area
  const handleCreateChannel = useCallback(async (name: string, focusSlug: string | null) => {
    setIsCreatingThread(true)
    try {
      const response = await apiFetch(`${API_HOST}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          focusSlug: focusSlug || undefined,
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to create channel: ${response.status}`)
      }

      const data = await response.json()
      const newThread: ThreadWithState = {
        id: data.channel.id,
        agentId: data.channel.id,
        agentName: data.channel.name || name,
        agentType: focusSlug || 'channel',
        agentState: 'idle',
        createdAt: data.channel.createdAt || new Date().toISOString(),
      }

      setThreads((prev) => [...prev, newThread])
      navigateToChannel(newThread.id)
    } catch (error) {
      console.error('Failed to create channel:', error)
      throw error // Re-throw so modal can handle it
    } finally {
      setIsCreatingThread(false)
    }
  }, [navigateToChannel])

  const handleSelectThread = useCallback((threadId: string) => {
    navigateToChannel(threadId)
  }, [navigateToChannel])

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!selectedThread) return
      sendMessage(content)
    },
    [selectedThread, sendMessage]
  )

  // Placeholder for channel selection (phase 2)
  const handleSelectChannel = useCallback((id: string) => {
    console.log('Channel selection coming in phase 2:', id)
  }, [])

  // Handle agent added to roster
  const handleAgentAdded = useCallback((agent: RosterAgent) => {
    setRoster(prev => [...prev, agent])
  }, [])

  // Handle agent dismissed from roster
  const handleAgentDismiss = useCallback(async (callsign: string) => {
    if (!selectedThread) return

    try {
      const response = await apiFetch(`${API_HOST}/channels/${selectedThread}/agents/${callsign}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to dismiss agent:', data.error || response.status)
        return
      }

      // Remove from local roster
      setRoster(prev => prev.filter(a => a.callsign !== callsign))
    } catch (error) {
      console.error('Failed to dismiss agent:', error)
    }
  }, [selectedThread])

  // Show onboarding page for new WorkOS users
  if (onboardingToken) {
    return (
      <OnboardingPage
        suggestedName={suggestedName}
        onboardingToken={onboardingToken}
        onComplete={handleOnboardingComplete}
        apiHost={API_HOST}
      />
    )
  }

  // Show loading while checking auth
  if (authSession === undefined) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // Show login page if not authenticated (dev mode only - prod redirects to /auth/login)
  if (authSession === null) {
    return <LoginPage onLogin={handleLogin} apiHost={API_HOST} />
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Unified header - spans full width */}
      <header className="h-12 flex items-center gap-3 px-5 border-b border-border bg-card flex-shrink-0">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1.5 rounded hover:bg-secondary/50 transition-colors"
          title={sidebarOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)'}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
          ) : (
            <PanelLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </button>

        {/* Branding */}
        <span className="font-semibold text-[#de946a] text-sm tracking-[0.05em]">CAST</span>

        {/* Channel name */}
        {selectedThread && (
          <>
            <span className="text-[#ccc]">—</span>
            <span className="font-medium text-foreground">#{currentThread?.agentName || 'channel'}</span>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Connection status */}
        {selectedThread && (
          <span className={`text-xs ${connected ? 'text-green-500' : 'text-muted-foreground'}`}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
        )}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-1.5 hover:bg-[var(--cast-bg-hover)] transition-colors"
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? (
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
        <aside className={cn(
          "flex flex-col bg-card border-r border-border transition-all duration-200 overflow-hidden",
          sidebarOpen ? "w-[220px]" : "w-0 border-r-0"
        )}>
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
              />
              <MessageList
                messages={messages}
                threadName={currentThread?.agentName}
                threadAgentType={currentThread?.agentType}
                apiHost={API_HOST}
                channelId={selectedThread || ''}
                roster={roster}
              />
              {/* Cold start indicator - shows when workspace container is starting */}
              {isStartingWorkspace && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-4 py-2 bg-secondary/30 flex-shrink-0">
                  <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                  <span>Starting workspace...</span>
                </div>
              )}
              {/* Simple thinking indicator - shows when waiting for response */}
              {isWaitingForResponse && !isStartingWorkspace && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-4 py-2 flex-shrink-0">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  <span>{currentThread?.agentName || 'Agent'} is thinking...</span>
                </div>
              )}
              {/* Input area with roster bar above message input */}
              <div className="border-t border-border bg-card">
                {/* Roster bar - horizontal row above input */}
                <div className="px-4 pt-3 pb-2">
                  <AgentRoster
                    roster={roster}
                    leader={leader}
                    agentTypes={agentTypes}
                    channelId={selectedThread || undefined}
                    apiHost={API_HOST}
                    onAgentAdded={handleAgentAdded}
                    onAgentDismiss={handleAgentDismiss}
                    canManageAgents={!!selectedThread}
                  />
                </div>
                {/* Message input below roster */}
                <MessageInput onSend={handleSendMessage} disabled={!connected} roster={roster} />
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
          refreshTrigger={artifactEventTrigger}
          selectedArtifact={urlState.artifactSlug}
          onSelectArtifact={focusArtifact}
          onClearSelection={clearArtifactFocus}
        />
      </div>
    </div>
  )
}
