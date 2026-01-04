import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { Hash, Bot, User, Flame, X, Settings, PanelLeftClose, PanelLeft, Pause, Play, LayoutGrid, Sun, Moon, Info } from 'lucide-react'
import { Message, Channel, ChannelMetadata, Participant, Agent, AgentOutput, ArtifactSummary, ArtifactEvent, AnyMessage } from './types'
import { fetchChannels, fetchMessages, fetchParticipants, sendMessage, subscribeToChannelWithArtifacts, spawnAgent, kickAgent, kickAllAgents, fetchAgents, fetchAgentOutput, fetchAgentWorkspaces, deleteAgentWorkspace, archiveChannel, fetchChannelMetadata, updateChannelMetadata, fetchChannelAgents, startChannelAgents, ChannelAgent, fetchArtifacts, updateArtifact, createArtifact, submitStructuredAsk, subscribeToCentralStream } from './api'
import { useUserConfig } from './useUserConfig'
import { formatTime, getUniqueSenders } from './utils'
import { cn } from '@/lib/utils'
import { parseHash, buildHash } from '@/lib/routing'
import { STATE_COLORS } from '@/lib/constants'

// UI Components
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

// Feature Components
import { NameModal, QuickNav } from '@/components/nav'
import { ChannelList, MessageList, MessageInput, NewChannelModal, AddAgentButton, EmptyStateChannelCreation, type MessageInputHandle } from '@/components/channel'
import { AgentDetailPane, AgentOutputItem } from '@/components/agent'
import { AppSettings, ChannelSettings } from '@/components/settings'
import { ArtifactTree, ArtifactPreview } from '@/components/board'

export default function App() {
  const { config, setName, isLoading } = useUserConfig()
  const [channels, setChannels] = useState<Channel[]>([])

  // Initialize state from URL hash
  const initialRoute = parseHash()
  const [currentChannel, setCurrentChannel] = useState<string | null>(initialRoute.channel)
  const [currentAgent, setCurrentAgent] = useState<string | null>(initialRoute.agent)
  const [allMessages, setAllMessages] = useState<AnyMessage[]>([])
  const [displayCount, setDisplayCount] = useState(40)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [workspaces, setWorkspaces] = useState<{ channel: string; name: string }[]>([])
  const [mobileView, setMobileView] = useState<'channels' | 'chat' | 'activity'>('channels')
  const [activityPaneOpen, setActivityPaneOpen] = useState(() => {
    try {
      return localStorage.getItem('powpow-activity-open') === 'true'
    } catch {
      return false
    }
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('powpow-theme') as 'light' | 'dark') || 'dark'
    } catch {
      return 'dark'
    }
  })
  const [activityTab, setActivityTab] = useState<'board' | 'firehose'>('board')
  const [firehoseData, setFirehoseData] = useState<(AgentOutput & { agentName: string })[]>([])
  const [activityPaneWidth, setActivityPaneWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('powpow-activity-width')
      return stored ? parseInt(stored, 10) : 640
    } catch {
      return 640
    }
  })
  const [firehoseFilter, setFirehoseFilter] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [selectedArtifactSlug, setSelectedArtifactSlug] = useState<string | null>(initialRoute.boardSlug)
  const [artifactEditMode, setArtifactEditMode] = useState(initialRoute.boardEdit)
  const [channelView, setChannelView] = useState<'chat' | 'settings'>(initialRoute.channelView === 'focus' ? 'chat' : initialRoute.channelView)
  const [channelMetadata, setChannelMetadata] = useState<ChannelMetadata>({})
  const [channelAgents, setChannelAgents] = useState<ChannelAgent[]>([])
  const [quickNavOpen, setQuickNavOpen] = useState(false)
  const [newChannelModalOpen, setNewChannelModalOpen] = useState(false)
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [appSettingsOpen, setAppSettingsOpen] = useState(initialRoute.appSettings)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem('powpow-sidebar-open')
      return stored !== 'false'
    } catch {
      return true
    }
  })
  const activityResizing = useRef(false)
  const firehoseRef = useRef<HTMLDivElement>(null)
  const firehoseWasAtBottom = useRef(true)
  const firehosePrevLength = useRef(0)
  const messageInputRef = useRef<MessageInputHandle>(null)

  // Persist sidebar state
  useEffect(() => {
    try {
      localStorage.setItem('powpow-sidebar-open', String(sidebarOpen))
    } catch {}
  }, [sidebarOpen])

  // Sync state to URL hash
  useEffect(() => {
    const newHash = buildHash({
      channel: currentChannel,
      agent: currentAgent,
      channelView,
      appSettings: appSettingsOpen,
      boardSlug: selectedArtifactSlug,
      boardEdit: artifactEditMode,
    })
    const currentHash = window.location.hash.slice(1)
    let decodedCurrent: string
    try {
      decodedCurrent = decodeURIComponent(currentHash)
    } catch {
      decodedCurrent = currentHash
    }
    if (decodedCurrent !== newHash) {
      window.history.replaceState(null, '', '#' + newHash)
    }
  }, [currentChannel, currentAgent, channelView, appSettingsOpen, selectedArtifactSlug, artifactEditMode])

  // Handle browser back/forward
  useEffect(() => {
    const handleHashChange = () => {
      const route = parseHash()
      setCurrentChannel(route.channel)
      setCurrentAgent(route.agent)
      setChannelView(route.channelView)
      setAppSettingsOpen(route.appSettings)
      setSelectedArtifactSlug(route.boardSlug)
      setArtifactEditMode(route.boardEdit)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setQuickNavOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Filter firehose data
  const filteredFirehoseData = firehoseFilter
    ? firehoseData.filter(item => item.agentName === firehoseFilter)
    : firehoseData

  // Open activity pane and focus firehose on specific agent
  const focusFirehoseOnAgent = useCallback((agentName: string) => {
    setFirehoseFilter(agentName)
    setActivityTab('firehose')
    setActivityPaneOpen(true)
  }, [])

  // Persist activity pane state
  useEffect(() => {
    localStorage.setItem('powpow-activity-open', String(activityPaneOpen))
  }, [activityPaneOpen])

  // Apply and persist theme
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    localStorage.setItem('powpow-theme', theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem('powpow-activity-width', String(activityPaneWidth))
  }, [activityPaneWidth])

  // Firehose auto-scroll
  const handleFirehoseScroll = useCallback(() => {
    const container = firehoseRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    firehoseWasAtBottom.current = scrollHeight - scrollTop - clientHeight < 20
  }, [])

  useLayoutEffect(() => {
    if (filteredFirehoseData.length === 0) return
    if (firehosePrevLength.current === 0 || firehoseWasAtBottom.current) {
      const container = firehoseRef.current
      if (container) {
        container.scrollTop = container.scrollHeight
      }
      firehoseWasAtBottom.current = true
    }
    firehosePrevLength.current = filteredFirehoseData.length
  }, [filteredFirehoseData])

  // Show only the latest N messages
  const messages = allMessages.slice(-displayCount)
  const hasMoreMessages = allMessages.length > displayCount

  const handleLoadMore = useCallback(() => {
    setDisplayCount(prev => Math.min(prev + 40, allMessages.length))
  }, [allMessages.length])

  // Fetch channels
  const loadChannels = useCallback(() => {
    return fetchChannels().then(setChannels).catch(console.error)
  }, [])

  // Fetch agents and workspaces
  const refreshAgents = useCallback(() => {
    fetchAgents().then(setAgents).catch(console.error)
    fetchAgentWorkspaces().then(setWorkspaces).catch(console.error)
  }, [])

  // Initial fetch on mount
  useEffect(() => {
    loadChannels()
    refreshAgents()
  }, [loadChannels, refreshAgents])

  // Subscribe to central SSE stream for real-time updates
  // This replaces polling for channels and agents
  useEffect(() => {
    const unsubscribe = subscribeToCentralStream({
      onChannelsChanged: () => {
        loadChannels()
      },
      onAgentsChanged: () => {
        refreshAgents()
      },
    })

    return unsubscribe
  }, [loadChannels, refreshAgents])

  // Auto-redirect on load: go to first channel or show create channel
  const hasInitialRoute = initialRoute.channel !== null
  const [hasAutoRedirected, setHasAutoRedirected] = useState(hasInitialRoute)

  useEffect(() => {
    if (hasAutoRedirected) return
    if (channels.length === 0) return // Still loading or no channels

    // Channels loaded - redirect to first non-root channel, or root if that's all there is
    const nonRootChannels = channels.filter(c => c.name !== 'root' && !c.archived)
    const targetChannel = nonRootChannels[0]?.name || (channels.find(c => c.name === 'root')?.name ?? null)

    if (targetChannel) {
      setCurrentChannel(targetChannel)
      setHasAutoRedirected(true)
    } else {
      // No channels at all - show create channel
      setShowCreateChannel(true)
      setHasAutoRedirected(true)
    }
  }, [channels, hasAutoRedirected])

  // Handle spawning an agent
  const handleSpawnAgent = useCallback(async (name: string) => {
    if (!currentChannel) return
    try {
      await spawnAgent(currentChannel, name)
      refreshAgents()
    } catch (err) {
      console.error('Failed to spawn:', err)
    }
  }, [currentChannel, refreshAgents])

  // Handle deleting agent workspace
  const handleDeleteWorkspace = useCallback(async (name: string) => {
    if (!currentChannel) return
    try {
      await deleteAgentWorkspace(currentChannel, name)
      refreshAgents()
    } catch (err) {
      console.error('Failed to delete workspace:', err)
    }
  }, [currentChannel, refreshAgents])

  // Handle archiving a channel
  const handleArchiveChannel = useCallback(async (channelName: string) => {
    try {
      await archiveChannel(channelName)
      const updated = await fetchChannels()
      setChannels(updated)
      if (channelName === currentChannel) {
        setCurrentChannel(null)
      }
    } catch (err) {
      console.error('Failed to archive channel:', err)
    }
  }, [currentChannel])

  // Format agent names for system messages
  const formatAgentList = useCallback((names: string[]) => {
    if (names.length === 0) return ''
    if (names.length === 1) return `@${names[0]}`
    if (names.length === 2) return `@${names[0]} and @${names[1]}`
    return names.slice(0, -1).map(n => `@${n}`).join(', ') + ` and @${names[names.length - 1]}`
  }, [])

  // Handle suspending a single agent
  const handleSuspendAgent = useCallback(async (agentName: string) => {
    if (!currentChannel || !config?.name) return
    await kickAgent(currentChannel, agentName)
    refreshAgents()
    await sendMessage(currentChannel, 'system', `@${config.name} suspended @${agentName}`)
  }, [currentChannel, config?.name, refreshAgents])

  // Handle resuming a single agent
  const handleResumeAgent = useCallback(async (agentName: string) => {
    if (!currentChannel || !config?.name) return
    await spawnAgent(currentChannel, agentName)
    refreshAgents()
    await sendMessage(currentChannel, 'system', `@${config.name} resumed @${agentName}`)
  }, [currentChannel, config?.name, refreshAgents])

  // Handle suspending all agents
  const handleSuspendAllAgents = useCallback(async (agentNames: string[]) => {
    if (!currentChannel || !config?.name || agentNames.length === 0) return
    await kickAllAgents(currentChannel)
    refreshAgents()
    await sendMessage(currentChannel, 'system', `@${config.name} suspended ${formatAgentList(agentNames)}`)
  }, [currentChannel, config?.name, refreshAgents, formatAgentList])

  // Handle resuming all roster agents
  const handleResumeAllAgents = useCallback(async (agentNames: string[]) => {
    if (!currentChannel || !config?.name || agentNames.length === 0) return
    await startChannelAgents(currentChannel)
    refreshAgents()
    await sendMessage(currentChannel, 'system', `@${config.name} resumed ${formatAgentList(agentNames)}`)
  }, [currentChannel, config?.name, refreshAgents, formatAgentList])

  // Subscribe to channel updates (messages and artifacts)
  useEffect(() => {
    if (!currentChannel || !config?.name) return

    // Load initial artifacts (exclude archived)
    fetchArtifacts(currentChannel)
      .then(artifacts => artifacts.filter(a => a.status !== 'archived'))
      .then(setArtifacts)
      .catch(console.error)

    // Fetch participants once when channel changes
    fetchParticipants(currentChannel).then(setParticipants).catch(console.error)

    const unsubscribe = subscribeToChannelWithArtifacts(currentChannel, config.name, {
      onMessages: (messages) => {
        setAllMessages(messages)
        // Update participants from new messages (avoids polling)
        setParticipants(prev => {
          const existingSenders = new Set(prev.map(p => p.sender))
          const newParticipants = [...prev]
          for (const msg of messages) {
            if (!existingSenders.has(msg.sender)) {
              existingSenders.add(msg.sender)
              newParticipants.push({ sender: msg.sender, connectedAt: Date.now() })
            }
          }
          return newParticipants.length > prev.length ? newParticipants : prev
        })
      },
      onArtifact: (event: ArtifactEvent) => {
        // Update artifacts list on artifact events (hide archived)
        setArtifacts(prev => {
          const summary: ArtifactSummary = {
            slug: event.artifact.slug,
            path: event.artifact.path,
            type: event.artifact.type,
            title: event.artifact.title || null,
            status: event.artifact.status,
            tldr: event.artifact.tldr,
            assignees: event.artifact.assignees || [],
            parentSlug: event.artifact.parentSlug || null,
            orderKey: event.artifact.orderKey,
          }
          // Remove from view if archived
          if (summary.status === 'archived') {
            return prev.filter(a => a.slug !== summary.slug)
          }
          if (event.action === 'created') {
            return [...prev, summary]
          } else if (event.action === 'updated') {
            return prev.map(a => a.slug === summary.slug ? summary : a)
          }
          return prev
        })
      },
    })

    return () => {
      unsubscribe()
    }
  }, [currentChannel, config?.name])

  // Fetch channel metadata and roster when channel changes
  useEffect(() => {
    if (!currentChannel) {
      setChannelMetadata({})
      setChannelAgents([])
      setArtifacts([])
      setSelectedArtifactSlug(null)
      return
    }
    fetchChannelMetadata(currentChannel).then(setChannelMetadata).catch(console.error)
    fetchChannelAgents(currentChannel).then(setChannelAgents).catch(console.error)
  }, [currentChannel])

  // Handle updating channel metadata
  const handleUpdateMetadata = useCallback(async (metadata: Partial<ChannelMetadata>) => {
    if (!currentChannel) return
    try {
      const result = await updateChannelMetadata(currentChannel, metadata)
      if (result.success && result.metadata) {
        setChannelMetadata(result.metadata)
      }
    } catch (err) {
      console.error('Failed to update metadata:', err)
    }
  }, [currentChannel])

  // Handle moving artifact to new parent (drag-and-drop reparenting)
  const handleMoveArtifact = useCallback(async (slug: string, newParentSlug: string | null, orderKey: string) => {
    if (!currentChannel || !config?.name) return
    try {
      await updateArtifact(currentChannel, slug, {
        parentSlug: newParentSlug || '',
        orderKey,
        updatedBy: config.name,
      })
      // The SSE subscription will handle updating the artifacts state
    } catch (err) {
      console.error('Failed to move artifact:', err)
    }
  }, [currentChannel, config?.name])

  // Handle creating new artifact
  const handleCreateArtifact = useCallback(async (type: string, slug: string, title: string, parentSlug: string | null, orderKey: string) => {
    if (!currentChannel || !config?.name) return
    try {
      const data: Parameters<typeof createArtifact>[1] = {
        slug,
        title,
        tldr: title,
        type,
        content: ' ',
        createdBy: config.name,
        orderKey,
      }
      if (parentSlug) data.parentSlug = parentSlug
      await createArtifact(currentChannel, data)
      // Navigate to the new artifact in edit mode
      setSelectedArtifactSlug(slug)
      setArtifactEditMode(true)
    } catch (err) {
      console.error('Failed to create artifact:', err)
    }
  }, [currentChannel, config?.name])

  // Fetch firehose data when activity pane is open and firehose tab selected
  useEffect(() => {
    if (!activityPaneOpen || activityTab !== 'firehose' || !currentChannel) {
      setFirehoseData([])
      return
    }

    const loadFirehose = async () => {
      const channelAgents = agents.filter(a => a.channel === currentChannel)
      const allOutputs: (AgentOutput & { agentName: string })[] = []

      for (const agent of channelAgents) {
        const output = await fetchAgentOutput(currentChannel, agent.name, 100)
        for (const item of output) {
          allOutputs.push({ ...item, agentName: agent.name })
        }
      }

      allOutputs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      setFirehoseData(allOutputs)
    }

    loadFirehose()
    const interval = setInterval(loadFirehose, 2000)
    return () => clearInterval(interval)
  }, [activityPaneOpen, activityTab, currentChannel, agents])

  const handleSelectChannel = useCallback((name: string) => {
    if (name !== currentChannel) {
      setCurrentChannel(name)
      setAllMessages([])
      setDisplayCount(40)
      setChannelMetadata({})
    }
    setCurrentAgent(null)
    setChannelView('chat')
    setMobileView('chat')
    setShowCreateChannel(false)
  }, [currentChannel])

  const handleSelectAgent = useCallback((channel: string, agentName: string) => {
    if (channel !== currentChannel) {
      setCurrentChannel(channel)
      setAllMessages([])
      setDisplayCount(40)
      setChannelMetadata({})
    }
    setCurrentAgent(agentName)
    setMobileView('chat')
  }, [currentChannel])

  const handleStructuredAskSubmit = async (messageId: string, values: Record<string, string | string[]>) => {
    if (!currentChannel || !config?.name) return
    try {
      const updated = await submitStructuredAsk(currentChannel, messageId, config.name, values)
      // Update the message in state with the submitted response
      setAllMessages(prev => prev.map(msg =>
        msg.id === messageId ? updated : msg
      ))
    } catch (err) {
      console.error('Failed to submit structured ask:', err)
    }
  }

  const handleSend = async (content: string) => {
    if (!currentChannel || !config?.name) return

    // Handle slash commands
    const summonMatch = content.match(/^\/summon\s+(.+)$/i)
    if (summonMatch) {
      const names = summonMatch[1]
        .split(/[\s,]+/)
        .map(n => n.replace(/^@/, '').trim())
        .filter(n => n.length > 0 && /^[\w-]+$/.test(n))

      if (names.length === 0) {
        await sendMessage(currentChannel, 'system', 'Usage: /summon name1, name2, ...')
        return
      }

      const results: string[] = []
      for (const name of names) {
        try {
          const result = await spawnAgent(currentChannel, name)
          results.push(result.message)
        } catch (err) {
          results.push(`Failed to summon ${name}: ${err}`)
        }
      }
      await sendMessage(currentChannel, 'system', results.join('\n'))
      return
    }

    const kickMatch = content.match(/^\/kick\s+(.+)$/i)
    if (kickMatch) {
      const names = kickMatch[1]
        .split(/[\s,]+/)
        .map(n => n.replace(/^@/, '').trim())
        .filter(n => n.length > 0 && /^[\w-]+$/.test(n))

      if (names.length === 0) {
        await sendMessage(currentChannel, 'system', 'Usage: /kick name1, name2, ...')
        return
      }

      const results: string[] = []
      for (const name of names) {
        try {
          const result = await kickAgent(currentChannel, name)
          results.push(result.message)
        } catch (err) {
          results.push(`Failed to kick ${name}: ${err}`)
        }
      }
      await sendMessage(currentChannel, 'system', results.join('\n'))
      return
    }

    if (/^\/kick-all\s*$/i.test(content)) {
      try {
        const result = await kickAllAgents(currentChannel)
        await sendMessage(currentChannel, 'system', result.message)
      } catch (err) {
        console.error('Failed to kick all:', err)
      }
      return
    }

    // Handle /dismiss - send to server and refresh roster
    if (/^\/dismiss\s+/i.test(content)) {
      try {
        await sendMessage(currentChannel, config.name, content)
        // Refresh channel agents to get updated dismissed status
        fetchChannelAgents(currentChannel).then(setChannelAgents)
      } catch (err) {
        console.error('Failed to dismiss:', err)
      }
      return
    }

    // Regular message
    try {
      await sendMessage(currentChannel, config.name, content)
      // Refresh channel agents in case we un-dismissed someone by @-mentioning
      fetchChannelAgents(currentChannel).then(setChannelAgents)
    } catch (err) {
      console.error('Failed to send:', err)
    }
  }

  const senders = getUniqueSenders(messages)

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!config) {
    return <NameModal onSubmit={setName} />
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Unified top header bar */}
      <div className="h-12 px-3 border-b flex items-center justify-between shrink-0 bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 hidden md:flex"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>

          <h1 className="text-sm font-semibold text-orange-500 shrink-0">CAST</h1>

          {currentChannel && !currentAgent && (
            <>
              <span className="text-muted-foreground shrink-0 hidden md:inline">/</span>
              <div className="flex items-center gap-2 min-w-0 flex-1 hidden md:flex">
                <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium shrink-0">{currentChannel}</span>
                {channelMetadata.tagline && (
                  <>
                    <span className="text-muted-foreground shrink-0">–</span>
                    {channelMetadata.mission ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors truncate text-left">
                            <span className="truncate">{channelMetadata.tagline}</span>
                            <Info className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="start">
                          <div className="space-y-2">
                            <h4 className="font-medium text-sm">Mission</h4>
                            <p className="text-sm text-muted-foreground">{channelMetadata.mission}</p>
                          </div>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span className="text-sm text-muted-foreground truncate">{channelMetadata.tagline}</span>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {currentAgent && currentChannel && (
            <>
              <span className="text-muted-foreground shrink-0 hidden md:inline">/</span>
              <div className="flex items-center gap-2 min-w-0 hidden md:flex">
                <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm shrink-0">{currentChannel}</span>
                <span className="text-muted-foreground shrink-0">/</span>
                <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium shrink-0">{currentAgent}</span>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            <span className="text-green-500">{config.name}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button
            variant={currentChannel === 'root' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => handleSelectChannel('root')}
            title="System resources"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Mobile nav */}
      <div className="md:hidden border-b">
        <Tabs value={mobileView} onValueChange={(v) => setMobileView(v as typeof mobileView)}>
          <TabsList className="w-full rounded-none h-10 bg-background">
            <TabsTrigger value="channels" className="flex-1 data-[state=active]:bg-secondary">
              <Hash className="h-4 w-4 mr-1" />
              Channels
            </TabsTrigger>
            <TabsTrigger value="chat" className="flex-1 data-[state=active]:bg-secondary" disabled={!currentChannel}>
              {currentChannel ? `#${currentChannel}` : 'Chat'}
            </TabsTrigger>
            <TabsTrigger value="activity" className="flex-1 data-[state=active]:bg-secondary" disabled={!currentChannel}>
              <LayoutGrid className="h-4 w-4 mr-1" />
              Activity
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Main content area */}
      {appSettingsOpen ? (
        <AppSettings
          onClose={() => setAppSettingsOpen(false)}
        />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Channels sidebar */}
          <div className={cn(
            'w-full md:w-56 bg-card border-r flex-shrink-0',
            mobileView === 'channels' ? 'flex flex-col' : 'hidden',
            (sidebarOpen || !currentChannel) ? 'md:flex md:flex-col' : 'md:hidden'
          )}>
            <ChannelList
              channels={channels}
              currentChannel={currentChannel}
              agents={agents}
              workspaces={workspaces}
              onSelect={handleSelectChannel}
              onSelectAgent={handleSelectAgent}
              onFocusFirehose={focusFirehoseOnAgent}
              onArchive={handleArchiveChannel}
              selectedAgent={currentAgent && currentChannel ? { channel: currentChannel, name: currentAgent } : null}
              onNewChannel={() => {
                setCurrentChannel(null)
                setCurrentAgent(null)
                setShowCreateChannel(true)
              }}
            />
          </div>

          {/* Main content area */}
          <div className={cn(
            'flex-1 flex flex-col min-w-0 min-h-0',
            mobileView === 'chat' ? 'flex' : 'hidden md:flex'
          )}>
            {currentAgent && currentChannel ? (
              <AgentDetailPane
                channel={currentChannel}
                agentName={currentAgent}
                agents={agents}
              />
            ) : currentChannel ? (
              <>
                {/* Horizontal nav */}
                <div className="px-3 py-1 border-b flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button
                      variant={channelView === 'chat' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setChannelView('chat')}
                    >
                      Chat
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant={channelView === 'settings' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setChannelView('settings')}
                    >
                      Mission
                    </Button>
                    {!activityPaneOpen && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 hidden md:flex"
                        onClick={() => setActivityPaneOpen(true)}
                        title="Activity"
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Content area */}
                {channelView === 'chat' ? (
                  <>
                    <MessageList
                      messages={messages}
                      myName={config.name}
                      channel={currentChannel}
                      onLoadMore={handleLoadMore}
                      hasMore={hasMoreMessages}
                      channelAgents={channelAgents}
                      onArtifactClick={(slug) => {
                        setActivityTab('board')
                        setSelectedArtifactSlug(slug)
                      }}
                      artifacts={artifacts.map(a => ({ slug: a.slug, title: a.title || a.slug, type: a.type, encoding: a.encoding, contentType: a.contentType }))}
                      onStructuredAskSubmit={handleStructuredAskSubmit}
                    />
                    <div className="relative">
                      {/* Floating controls above message input */}
                      <div className="absolute -top-10 right-3 flex items-center gap-1.5 z-10">
                        {/* Add agent button */}
                        <AddAgentButton
                          channel={currentChannel}
                          onInsert={(text) => messageInputRef.current?.insertText(text)}
                        />
                        {/* Pause/Play all button */}
                        {(() => {
                          const activeAgents = agents.filter(a => a.channel === currentChannel)
                          const hasActive = activeAgents.length > 0
                          const hasRoster = channelAgents.length > 0

                          if (!hasActive && !hasRoster) return null

                          return hasActive ? (
                            <button
                              onClick={() => handleSuspendAllAgents(activeAgents.map(a => a.name))}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive border bg-background rounded-full px-2.5 py-1 hover:border-destructive/50 transition-colors shadow-sm"
                              title="Stop all agents"
                            >
                              <Pause className="h-3 w-3" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleResumeAllAgents(channelAgents.map(a => a.name))}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-green-500 border bg-background rounded-full px-2.5 py-1 hover:border-green-500/50 transition-colors shadow-sm"
                              title="Start all agents"
                            >
                              <Play className="h-3 w-3" />
                            </button>
                          )
                        })()}
                      </div>
                      <MessageInput
                        ref={messageInputRef}
                        onSend={handleSend}
                        senders={senders}
                        participants={participants}
                        agents={agents}
                        channelAgents={channelAgents}
                        currentChannel={currentChannel}
                        myName={config.name}
                      />
                    </div>
                  </>
                ) : (
                  <ChannelSettings
                    channel={currentChannel}
                    metadata={channelMetadata}
                    onUpdate={handleUpdateMetadata}
                  />
                )}
              </>
            ) : showCreateChannel ? (
              <EmptyStateChannelCreation
                userName={config?.name}
                onChannelCreated={() => {
                  setShowCreateChannel(false)
                  loadChannels()
                }}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
                <span>Select a channel to start chatting</span>
                <Button
                  variant="outline"
                  onClick={() => setShowCreateChannel(true)}
                >
                  Create a new channel
                </Button>
              </div>
            )}
          </div>

          {/* Activity Pane */}
          {(activityPaneOpen || mobileView === 'activity') && currentChannel && (
            <div
              className={cn(
                'bg-card border-l flex-col flex-shrink-0 relative',
                mobileView === 'activity' ? 'flex w-full' : 'hidden md:flex'
              )}
              style={mobileView === 'activity' ? undefined : { width: activityPaneWidth }}
            >
              {/* Resize handle (desktop only) */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary/50 z-10 hidden md:block"
                onMouseDown={(e) => {
                  e.preventDefault()
                  activityResizing.current = true
                  const startX = e.clientX
                  const startWidth = activityPaneWidth

                  const onMouseMove = (e: MouseEvent) => {
                    if (!activityResizing.current) return
                    const delta = startX - e.clientX
                    const newWidth = Math.max(320, Math.min(1200, startWidth + delta))
                    setActivityPaneWidth(newWidth)
                  }

                  const onMouseUp = () => {
                    activityResizing.current = false
                    document.removeEventListener('mousemove', onMouseMove)
                    document.removeEventListener('mouseup', onMouseUp)
                  }

                  document.addEventListener('mousemove', onMouseMove)
                  document.addEventListener('mouseup', onMouseUp)
                }}
              />
              {/* Header with tabs */}
              <div className="px-3 py-1 border-b flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setActivityTab('board'); setSelectedArtifactSlug(null) }}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors',
                      activityTab === 'board' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    Board
                  </button>
                  <button
                    onClick={() => setActivityTab('firehose')}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors',
                      activityTab === 'firehose' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Flame className="h-3.5 w-3.5" />
                    Firehose
                  </button>
                  {activityTab === 'firehose' && firehoseFilter && (
                    <button
                      onClick={() => setFirehoseFilter(null)}
                      className="flex items-center gap-1 text-[10px] bg-orange-500/20 text-orange-500 rounded px-1.5 py-0.5 hover:bg-orange-500/30"
                    >
                      <span>{firehoseFilter}</span>
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 hidden md:flex"
                  onClick={() => setActivityPaneOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Board tab content */}
              {activityTab === 'board' && (
                selectedArtifactSlug ? (
                  <ArtifactPreview
                    channel={currentChannel}
                    slug={selectedArtifactSlug}
                    onBack={() => {
                      setSelectedArtifactSlug(null)
                      setArtifactEditMode(false)
                    }}
                    onNavigate={(slug) => {
                      setSelectedArtifactSlug(slug)
                      setArtifactEditMode(false)
                    }}
                    editing={artifactEditMode}
                    onEditingChange={setArtifactEditMode}
                  />
                ) : (
                  <div className="flex-1 overflow-y-auto min-h-0">
                    <ArtifactTree
                      artifacts={artifacts}
                      onSelect={(artifact) => setSelectedArtifactSlug(artifact.slug)}
                      selectedPath={undefined}
                      onMove={handleMoveArtifact}
                      onCreate={handleCreateArtifact}
                      channel={currentChannel || undefined}
                    />
                  </div>
                )
              )}

              {/* Firehose tab content */}
              {activityTab === 'firehose' && (
                <>
                  {/* Roster section */}
                  {(() => {
                    // Sort channel agents by creation time (point agent first)
                    const sortedChannelAgents = [...channelAgents].sort((a, b) =>
                      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                    )
                    const activeAgents = agents
                      .filter(a => a.channel === currentChannel)
                      .sort((a, b) => {
                        // Sort by roster order (createdAt)
                        const aIndex = sortedChannelAgents.findIndex(ca => ca.name === a.name)
                        const bIndex = sortedChannelAgents.findIndex(ca => ca.name === b.name)
                        return aIndex - bIndex
                      })
                    const activeNames = new Set(activeAgents.map(a => a.name))
                    const inactiveRoster = sortedChannelAgents.filter(ca => !activeNames.has(ca.name))

                    if (activeAgents.length === 0 && inactiveRoster.length === 0) return null

                    return (
                      <div className="px-3 py-2 border-b space-y-1.5 shrink-0">
                        {/* Active agents */}
                        {activeAgents.map(agent => {
                          const isFiltered = firehoseFilter === agent.name
                          return (
                            <div key={agent.name} className="flex items-center gap-2 text-xs group">
                              <span className={cn('w-2 h-2 rounded-full shrink-0', STATE_COLORS[agent.state])} />
                              <button
                                onClick={() => setFirehoseFilter(isFiltered ? null : agent.name)}
                                className={cn(
                                  'font-medium hover:underline',
                                  isFiltered && 'text-orange-500'
                                )}
                              >
                                {agent.name}
                              </button>
                              <span className="flex-1 text-muted-foreground truncate text-[11px]">
                                {agent.status || ''}
                              </span>
                              <button
                                onClick={() => handleSuspendAgent(agent.name)}
                                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-all"
                                title="Stop agent"
                              >
                                <Pause className="h-3 w-3" />
                              </button>
                            </div>
                          )
                        })}
                        {/* Inactive roster agents */}
                        {inactiveRoster.map(rosterAgent => {
                          return (
                            <div key={rosterAgent.name} className="flex items-center gap-2 text-xs text-muted-foreground group">
                              <span className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/30" />
                              <span>{rosterAgent.name}</span>
                              <span className="flex-1" />
                              <button
                                onClick={() => handleResumeAgent(rosterAgent.name)}
                                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-green-500/20 hover:text-green-500 transition-all"
                                title="Start agent"
                              >
                                <Play className="h-3 w-3" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                  <div
                    ref={firehoseRef}
                    onScroll={handleFirehoseScroll}
                    className="flex-1 overflow-y-auto min-h-0"
                  >
                    <div className="p-3 space-y-3">
                      {filteredFirehoseData.length === 0 ? (
                        <div className="text-center text-muted-foreground text-sm py-4">
                          {firehoseFilter ? `No activity from ${firehoseFilter}` : 'No agent activity yet'}
                        </div>
                      ) : (
                        filteredFirehoseData.map((item, i) => (
                          <div key={`${item.agentName}-${item.timestamp}-${i}`} className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {item.agentName}
                              </Badge>
                              <span className="text-muted-foreground">
                                {formatTime(item.timestamp)}
                              </span>
                            </div>
                            <AgentOutputItem item={item} />
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Quick Navigator (Cmd+K) */}
      <QuickNav
        open={quickNavOpen}
        onClose={() => setQuickNavOpen(false)}
        channels={channels}
        onSelectChannel={handleSelectChannel}
        onNewChannel={() => {
          setQuickNavOpen(false)
          setCurrentChannel(null)
          setCurrentAgent(null)
          setShowCreateChannel(true)
        }}
      />

      {/* New Channel Modal */}
      <NewChannelModal
        open={newChannelModalOpen}
        onClose={() => setNewChannelModalOpen(false)}
        userName={config?.name}
      />
    </div>
  )
}
