import { useState, useCallback, useRef, useEffect, KeyboardEvent, useMemo } from 'react'
import {
  Send,
  Paperclip,
  AtSign,
  Sparkles,
  Play,
  Pause,
  PlayCircle,
  PauseCircle,
  Search,
  X,
  Loader2,
  Plus
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { MentionAutocomplete, useMentionAutocomplete, type RosterAgent } from './MentionAutocomplete'
import { getSenderColor } from '../../utils'

interface MessageInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
  roster?: RosterAgent[]
  channelId?: string
  apiHost?: string
  onSummon?: () => void
}

// Slash commands configuration
const SLASH_COMMANDS = [
  { name: 'summon', description: 'Summon an agent to the channel', icon: Sparkles },
  { name: 'pause', description: 'Pause an agent', icon: Pause },
  { name: 'resume', description: 'Resume a paused agent', icon: Play },
  { name: 'pause-all', description: 'Pause all active agents', icon: PauseCircle },
  { name: 'resume-all', description: 'Resume all paused agents', icon: PlayCircle },
]

export function MessageInput({
  onSend,
  disabled,
  placeholder = 'Type a message...',
  roster = [],
  channelId,
  apiHost,
  onSummon,
}: MessageInputProps) {
  const [content, setContent] = useState('')
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentionStart, setMentionStart] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Slash command state
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const slashMenuRef = useRef<HTMLDivElement>(null)

  // Agent action picker state (for /pause and /resume commands)
  const [showAgentPicker, setShowAgentPicker] = useState<'pause' | 'resume' | null>(null)
  const [agentPickerQuery, setAgentPickerQuery] = useState('')
  const [agentPickerIndex, setAgentPickerIndex] = useState(0)
  const [agentActionLoading, setAgentActionLoading] = useState(false)

  // Loading state for resume actions in dormant dialog
  const [dormantActionLoading, setDormantActionLoading] = useState<string | null>(null)

  // Sticky mentions prefix (used for pre-populating next message)
  const [, setStickyPrefix] = useState('')

  const { findMentionTrigger, getOptionsCount, getOptionAtIndex } = useMentionAutocomplete(roster)

  // Agents that can be paused (online and not paused)
  const pausableAgents = useMemo(() =>
    roster.filter(a => a.isOnline && !a.isPaused),
    [roster]
  )

  // Agents that can be resumed (paused)
  const resumableAgents = useMemo(() =>
    roster.filter(a => a.isPaused),
    [roster]
  )

  // Filter agents for picker based on query
  const getFilteredPickerAgents = useCallback((action: 'pause' | 'resume', query: string) => {
    const agents = action === 'pause' ? pausableAgents : resumableAgents
    if (!query) return agents
    return agents.filter(a => a.callsign.toLowerCase().includes(query.toLowerCase()))
  }, [pausableAgents, resumableAgents])

  // Extract leading @mentions from content for sticky behavior
  const extractLeadingMentions = useCallback((text: string): string => {
    const match = text.match(/^(@\w+\s*)+/)
    return match ? match[0] : ''
  }, [])

  // Paused agents mentioned in current content
  const dormantAgents = useMemo(() => {
    const mentionRegex = /@(\w+)/g
    const mentions: string[] = []
    let match
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1])
    }
    // Only include paused roster agents
    return roster.filter(a => a.isPaused && mentions.includes(a.callsign))
  }, [content, roster])

  // Handle resume action for paused agent from dormant dialog
  const handleResumeDormant = useCallback(async (callsign: string) => {
    if (!apiHost || !channelId) return
    setDormantActionLoading(callsign)
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${callsign}/resume`,
        { method: 'POST' }
      )
      const data = await response.json()
      if (!response.ok) {
        console.error('Failed to resume agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to resume agent:', err)
    } finally {
      setDormantActionLoading(null)
    }
  }, [apiHost, channelId])

  // Handle pause/resume action from agent picker
  const handleAgentAction = useCallback(async (action: 'pause' | 'resume', callsign: string) => {
    if (!apiHost || !channelId) return
    setAgentActionLoading(true)
    try {
      const endpoint = action === 'pause' ? 'pause' : 'resume'
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${callsign}/${endpoint}`,
        { method: 'POST' }
      )
      const data = await response.json()
      if (!response.ok) {
        console.error(`Failed to ${action} agent:`, data.error || response.status)
      }
    } catch (err) {
      console.error(`Failed to ${action} agent:`, err)
    } finally {
      setAgentActionLoading(false)
      setShowAgentPicker(null)
      setAgentPickerQuery('')
      setAgentPickerIndex(0)
    }
  }, [apiHost, channelId])

  // Handle bulk pause/resume actions
  const handleBulkAgentAction = useCallback(async (action: 'pause-all' | 'resume-all') => {
    if (!apiHost || !channelId) return
    const agents = action === 'pause-all' ? pausableAgents : resumableAgents
    const endpoint = action === 'pause-all' ? 'pause' : 'resume'

    await Promise.all(
      agents.map(async (agent) => {
        try {
          await fetch(
            `${apiHost}/channels/${channelId}/agents/${agent.callsign}/${endpoint}`,
            { method: 'POST' }
          )
        } catch (err) {
          console.error(`Failed to ${endpoint} agent ${agent.callsign}:`, err)
        }
      })
    )
  }, [apiHost, channelId, pausableAgents, resumableAgents])

  // Filter slash commands based on query
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(cmd =>
      cmd.name.toLowerCase().includes(slashQuery.toLowerCase())
    )
  }, [slashQuery])

  // Execute slash command
  const executeSlashCommand = useCallback((command: string) => {
    setShowSlashMenu(false)
    setSlashQuery('')
    setContent('')

    if (command === 'summon') {
      onSummon?.()
    } else if (command === 'pause') {
      if (pausableAgents.length > 0) {
        setShowAgentPicker('pause')
      }
    } else if (command === 'resume') {
      if (resumableAgents.length > 0) {
        setShowAgentPicker('resume')
      }
    } else if (command === 'pause-all') {
      handleBulkAgentAction('pause-all')
    } else if (command === 'resume-all') {
      handleBulkAgentAction('resume-all')
    }
  }, [onSummon, pausableAgents, resumableAgents, handleBulkAgentAction])

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim()
    if (!trimmed) return

    // Extract leading mentions for sticky behavior
    const leadingMentions = extractLeadingMentions(trimmed)
    setStickyPrefix(leadingMentions)

    onSend(trimmed)
    setContent(leadingMentions) // Pre-populate with sticky mentions
    setShowAutocomplete(false)
    setShowSlashMenu(false)
  }, [content, onSend, extractLeadingMentions])

  // Insert mention at the trigger position
  const insertMention = useCallback((mention: string) => {
    const before = content.slice(0, mentionStart)
    const after = content.slice(textareaRef.current?.selectionStart ?? content.length)
    const newContent = `${before}@${mention} ${after}`
    setContent(newContent)
    setShowAutocomplete(false)

    // Focus and set cursor position after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = mentionStart + mention.length + 2 // +2 for @ and space
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
      }
    })
  }, [content, mentionStart])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle agent picker navigation
      if (showAgentPicker) {
        const agents = getFilteredPickerAgents(showAgentPicker, agentPickerQuery)

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAgentPickerIndex((prev) => (prev + 1) % agents.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAgentPickerIndex((prev) => (prev - 1 + agents.length) % agents.length)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          const selected = agents[agentPickerIndex]
          if (selected) {
            handleAgentAction(showAgentPicker, selected.callsign)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowAgentPicker(null)
          setAgentPickerQuery('')
          setAgentPickerIndex(0)
          return
        }
        return
      }

      // Handle slash menu navigation
      if (showSlashMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = filteredCommands[slashSelectedIndex]
          if (selected) {
            executeSlashCommand(selected.name)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowSlashMenu(false)
          return
        }
      }

      // Handle autocomplete navigation
      if (showAutocomplete) {
        const optionsCount = getOptionsCount(autocompleteQuery)

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % optionsCount)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + optionsCount) % optionsCount)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = getOptionAtIndex(autocompleteQuery, selectedIndex)
          if (selected) {
            insertMention(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowAutocomplete(false)
          return
        }
      }

      // Submit on Enter (without Shift) when no menus are showing
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [
      showAgentPicker, agentPickerQuery, agentPickerIndex, getFilteredPickerAgents, handleAgentAction,
      showSlashMenu, filteredCommands, slashSelectedIndex, executeSlashCommand,
      showAutocomplete, autocompleteQuery, selectedIndex, getOptionsCount, getOptionAtIndex,
      insertMention, handleSubmit
    ]
  )

  // Handle input changes and detect triggers
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value
      const cursorPos = e.target.selectionStart

      setContent(newContent)

      // Check for slash command trigger at start of input
      if (newContent.startsWith('/')) {
        const query = newContent.slice(1)
        // Only show slash menu if no space yet (still typing command)
        if (!query.includes(' ')) {
          setShowSlashMenu(true)
          setSlashQuery(query)
          setSlashSelectedIndex(0)
          setShowAutocomplete(false)
          return
        }
      }
      setShowSlashMenu(false)

      // Check for mention trigger
      const trigger = findMentionTrigger(newContent, cursorPos)
      if (trigger) {
        setShowAutocomplete(true)
        setAutocompleteQuery(trigger.query)
        setMentionStart(trigger.start)
        setSelectedIndex(0)
      } else {
        setShowAutocomplete(false)
      }
    },
    [findMentionTrigger]
  )

  // Handle @ button click
  const handleAtButtonClick = useCallback(() => {
    if (textareaRef.current) {
      const cursorPos = textareaRef.current.selectionStart
      const before = content.slice(0, cursorPos)
      const after = content.slice(cursorPos)
      const newContent = `${before}@${after}`
      setContent(newContent)
      setMentionStart(cursorPos)
      setAutocompleteQuery('')
      setSelectedIndex(0)
      setShowAutocomplete(true)

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos + 1, cursorPos + 1)
        }
      })
    }
  }, [content])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [content])

  // Update agent picker query when typing in picker mode
  useEffect(() => {
    if (showAgentPicker) {
      setAgentPickerQuery(content)
      setAgentPickerIndex(0)
    }
  }, [content, showAgentPicker])

  // Close slash menu on click outside
  useEffect(() => {
    if (!showSlashMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSlashMenu])

  // Calculate autocomplete position (above the textarea)
  const getAutocompletePosition = () => {
    return { top: 8, left: 16 }
  }

  return (
    <div className="px-4 pt-0 pb-4 bg-card">
      <div className="relative">
        {/* Slash command menu */}
        {showSlashMenu && filteredCommands.length > 0 && (
          <div
            ref={slashMenuRef}
            className="absolute z-50 bg-white border border-[var(--cast-border-default)] shadow-sm py-1 min-w-[180px] max-h-[200px] overflow-y-auto"
            style={{ bottom: 8, left: 16 }}
          >
            {filteredCommands.map((cmd, index) => {
              const Icon = cmd.icon
              return (
                <button
                  key={cmd.name}
                  data-selected={index === slashSelectedIndex}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                    "hover:bg-[#f5f5f5] transition-colors",
                    index === slashSelectedIndex && "bg-[#f5f5f5]"
                  )}
                  onClick={() => executeSlashCommand(cmd.name)}
                >
                  <Icon className="w-4 h-4 text-[var(--cast-text-muted)]" />
                  <span className="font-medium text-[var(--cast-text-primary)]">{cmd.name}</span>
                  <span className="text-[var(--cast-text-muted)] text-xs ml-auto">{cmd.description}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Agent action picker (for /pause and /resume) */}
        {showAgentPicker && (
          <AgentActionPicker
            action={showAgentPicker}
            agents={getFilteredPickerAgents(showAgentPicker, agentPickerQuery)}
            allAgents={showAgentPicker === 'pause' ? pausableAgents : resumableAgents}
            selectedIndex={agentPickerIndex}
            query={agentPickerQuery}
            loading={agentActionLoading}
            onQueryChange={(q) => {
              setAgentPickerQuery(q)
              setAgentPickerIndex(0)
            }}
            onSelectAgent={(callsign) => handleAgentAction(showAgentPicker, callsign)}
            onClose={() => {
              setShowAgentPicker(null)
              setAgentPickerQuery('')
              setAgentPickerIndex(0)
            }}
          />
        )}

        {/* Mention autocomplete */}
        {showAutocomplete && !showAgentPicker && (
          <MentionAutocomplete
            query={autocompleteQuery}
            roster={roster}
            selectedIndex={selectedIndex}
            onSelect={insertMention}
            onClose={() => setShowAutocomplete(false)}
            position={getAutocompletePosition()}
            channelId={channelId}
          />
        )}

        {/* Dormant agents notice - compact inline style */}
        {dormantAgents.length > 0 && !showAgentPicker && !showSlashMenu && (
          <div
            className="absolute z-40 bg-card border border-border rounded-lg shadow-sm px-3 py-2 text-sm"
            style={{ bottom: 8, left: 16 }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground">Paused:</span>
              {dormantAgents.map((agent) => (
                <span key={agent.callsign} className="flex items-center gap-1">
                  <span className={cn("font-medium", getSenderColor(agent.callsign))}>
                    @{agent.callsign}
                  </span>
                  <button
                    onClick={() => handleResumeDormant(agent.callsign)}
                    disabled={dormantActionLoading === agent.callsign}
                    className={cn(
                      "p-0.5 rounded hover:bg-secondary/50 transition-colors",
                      dormantActionLoading === agent.callsign && "opacity-50 cursor-not-allowed"
                    )}
                    title="Resume agent"
                  >
                    {dormantActionLoading === agent.callsign ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <Play className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Input box container */}
        <div className="border border-[var(--cast-border-default)] focus-within:border-[#1a1a1a] transition-colors">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={showAgentPicker
              ? `Type to filter ${showAgentPicker === 'pause' ? 'active' : 'paused'} agents...`
              : placeholder
            }
            disabled={disabled}
            rows={1}
            className={cn(
              "w-full min-h-[44px] max-h-[200px] resize-none p-3",
              "bg-transparent border-none",
              "text-sm text-foreground placeholder:text-[#a0a0a0]",
              "focus:outline-none focus:ring-0",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />
          {/* Input actions row */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-[#f0f0f0]">
            {/* Left side buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Attach file"
              >
                <Paperclip className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                onClick={handleAtButtonClick}
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Mention"
              >
                <AtSign className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                onClick={onSummon}
                className="flex items-center gap-1 px-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors text-sm"
                title="Summon agent"
              >
                <Plus className="w-[18px] h-[18px]" />
                <span>Summon</span>
              </button>
            </div>
            {/* Send button */}
            <button
              onClick={handleSubmit}
              disabled={disabled || !content.trim()}
              className={cn(
                "p-1 transition-colors",
                content.trim() && !disabled
                  ? "text-[#8c8c8c] hover:text-[#1a1a1a]"
                  : "text-[#c0c0c0] cursor-not-allowed"
              )}
              title="Send message"
            >
              <Send className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Agent action picker component for /pause and /resume commands
interface AgentActionPickerProps {
  action: 'pause' | 'resume'
  agents: RosterAgent[]
  allAgents: RosterAgent[]
  selectedIndex: number
  query: string
  loading: boolean
  onQueryChange: (query: string) => void
  onSelectAgent: (callsign: string) => void
  onClose: () => void
}

function AgentActionPicker({
  action,
  agents,
  allAgents,
  selectedIndex,
  query,
  loading,
  onQueryChange,
  onSelectAgent,
  onClose,
}: AgentActionPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Scroll selected item into view
  useEffect(() => {
    const selected = containerRef.current?.querySelector('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Handled by parent
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      // Handled by parent
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selected = agents[selectedIndex]
      if (selected) {
        onSelectAgent(selected.callsign)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-50 bg-card border border-border rounded-lg shadow-lg min-w-[280px] max-h-[300px] overflow-hidden"
      style={{ bottom: 8, left: 16 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">
          {action === 'pause' ? 'Pause Agent' : 'Resume Agent'}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-secondary/50 transition-colors"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Search input */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-1.5 bg-secondary/30 rounded">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Search ${action === 'pause' ? 'active' : 'paused'} agents...`}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Agent list */}
      <div className="max-h-[180px] overflow-y-auto py-1">
        {agents.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {allAgents.length === 0
              ? `No ${action === 'pause' ? 'active' : 'paused'} agents`
              : 'No matching agents'
            }
          </div>
        ) : (
          agents.map((agent, index) => (
            <button
              key={agent.callsign}
              data-selected={index === selectedIndex}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                "hover:bg-secondary/50 transition-colors",
                index === selectedIndex && "bg-secondary"
              )}
              onClick={() => onSelectAgent(agent.callsign)}
              disabled={loading}
            >
              <span className={cn(
                "w-2 h-2 rounded-full",
                agent.isPaused ? "bg-gray-400" : "bg-green-500"
              )} />
              <span className={cn("font-medium", getSenderColor(agent.callsign))}>
                {agent.callsign}
              </span>
              <span className="text-muted-foreground text-xs ml-auto">
                {agent.isPaused ? 'paused' : 'active'}
              </span>
              {loading && index === selectedIndex && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
