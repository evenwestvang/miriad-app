import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { SLASH_COMMANDS } from '@/lib/constants'

// Text colors matching STATE_COLORS for roster display
const STATE_TEXT_COLORS: Record<string, string> = {
  starting: 'text-yellow-500',
  idle: 'text-green-500',
  thinking: 'text-blue-500 animate-pulse',
  tool_running: 'text-purple-500 animate-pulse',
  stopped: 'text-muted-foreground',
  error: 'text-destructive',
}
import { Participant, Agent } from '@/types'
import { ChannelAgent } from '@/api'

type Suggestion = { name: string; description?: string; type: 'mention' | 'command' }

interface MessageInputProps {
  onSend: (content: string) => void
  senders: string[]
  participants: Participant[]
  agents: Agent[]
  channelAgents: ChannelAgent[]
  currentChannel: string
  myName: string
}

export interface MessageInputHandle {
  insertText: (text: string) => void
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  onSend,
  senders,
  participants,
  agents,
  channelAgents,
  currentChannel,
  myName,
}, ref) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showUnknownError, setShowUnknownError] = useState<string[] | null>(null)
  const [showDismissedWarning, setShowDismissedWarning] = useState<string[] | null>(null)
  const [forceAttempts, setForceAttempts] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Get active agents for this channel
  const activeAgentNames = new Set(agents.filter(a => a.channel === currentChannel).map(a => a.name.toLowerCase()))
  // Roster agents (not dismissed)
  const rosterAgentNames = new Set(channelAgents.filter(a => !a.dismissed).map(a => a.name.toLowerCase()))
  // Dismissed agents
  const dismissedAgentNames = new Set(channelAgents.filter(a => a.dismissed).map(a => a.name.toLowerCase()))
  // Participants (humans online)
  const participantNames = new Set(participants.map(p => p.sender.toLowerCase()))

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px'
    }
  }, [value])

  // Reset force attempts when value changes
  useEffect(() => {
    setForceAttempts(0)
    setShowUnknownError(null)
    setShowDismissedWarning(null)
  }, [value])

  // Build status map from participants
  const statusMap = new Map(participants.map(p => [p.sender, p.status]))

  // Build agent state map for roster display
  const agentStateMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const agent of agents) {
      if (agent.channel === currentChannel) {
        map.set(agent.name.toLowerCase(), agent.state)
      }
    }
    return map
  }, [agents, currentChannel])

  // Get non-dismissed roster agents for display, sorted by creation time (point agent first)
  const activeRoster = useMemo(() => {
    return channelAgents
      .filter(a => !a.dismissed)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [channelAgents])

  // Expose insertText method via ref
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      setValue(prev => prev ? `${prev} ${text}` : text)
      inputRef.current?.focus()
    }
  }), [])

  const isSlashCommand = /^\/(summon|kick|kick-all)\s*/i.test(value)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

    // Check for slash command autocomplete (only at start of input)
    const slashMatch = newValue.match(/^\/(\w*)$/)
    if (slashMatch) {
      const query = slashMatch[1].toLowerCase()
      const filtered = SLASH_COMMANDS
        .filter(cmd => cmd.command.slice(1).startsWith(query))
        .map(cmd => ({ name: cmd.command.slice(1), description: cmd.description, type: 'command' as const }))
      setSuggestions(filtered)
      setSelectedIndex(0)
      setOpen(filtered.length > 0)
      return
    }

    // Check for @ mention autocomplete
    const mentionMatch = newValue.match(/@(\w*)$/)
    if (mentionMatch) {
      const query = mentionMatch[1].toLowerCase()
      // Merge senders (from messages), participants (currently online), and roster agents
      const participantNamesList = participants.map(p => p.sender)
      const rosterNames = channelAgents.map(a => a.name)
      // Combine all names, excluding system and self
      const excluded = new Set(['system', myName.toLowerCase()])
      const allNames = [...new Set([...rosterNames, ...participantNamesList, ...senders])]
        .filter(name => !excluded.has(name.toLowerCase()))
      // Sort: roster agents first, then others, @channel always last
      const filtered = allNames
        .filter(s => s.toLowerCase().startsWith(query))
        .sort((a, b) => {
          const aIsRoster = rosterAgentNames.has(a.toLowerCase())
          const bIsRoster = rosterAgentNames.has(b.toLowerCase())
          if (aIsRoster && !bIsRoster) return -1
          if (!aIsRoster && bIsRoster) return 1
          return a.localeCompare(b)
        })
        .slice(0, 8)
        .map(name => {
          // Show status for participants
          const status = statusMap.get(name)
          return { name, description: status, type: 'mention' as const }
        })
      // Add @channel at the end if it matches
      if ('channel'.startsWith(query)) {
        filtered.push({ name: 'channel', description: 'everyone', type: 'mention' as const })
      }
      setSuggestions(filtered)
      setSelectedIndex(0)
      setOpen(filtered.length > 0)
      return
    }

    setOpen(false)
  }

  const completeSuggestion = (suggestion: Suggestion) => {
    if (suggestion.type === 'command') {
      setValue('/' + suggestion.name + ' ')
    } else {
      const newValue = value.replace(/@\w*$/, '@' + suggestion.name + ' ')
      setValue(newValue)
    }
    setOpen(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle autocomplete navigation
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, suggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        completeSuggestion(suggestions[selectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }

    // Send message on Enter
    if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
      e.preventDefault()
      trySend()
    }
  }

  const getUnrecognizedMentions = (): string[] => {
    const mentions = value.match(/@([\w-]+)/g)?.map(m => m.slice(1)) || []
    const unrecognized: string[] = []

    for (const name of mentions) {
      const nameLower = name.toLowerCase()
      if (name === 'channel') continue
      if (activeAgentNames.has(nameLower)) continue
      if (rosterAgentNames.has(nameLower)) continue
      if (dismissedAgentNames.has(nameLower)) continue // Dismissed agents are known, just archived
      if (participantNames.has(nameLower)) continue
      unrecognized.push(name)
    }

    return unrecognized
  }

  const getDismissedMentions = (): string[] => {
    const mentions = value.match(/@([\w-]+)/g)?.map(m => m.slice(1)) || []
    const dismissed: string[] = []

    for (const name of mentions) {
      const nameLower = name.toLowerCase()
      if (dismissedAgentNames.has(nameLower)) {
        dismissed.push(name)
      }
    }

    return dismissed
  }

  const trySend = () => {
    if (!value.trim()) return

    if (isSlashCommand) {
      // Slash commands don't need mentions
      onSend(value.trim())
      setValue('')
      return
    }

    // Check for dismissed mentions (warn but allow re-summon)
    const dismissed = getDismissedMentions()
    if (dismissed.length > 0 && forceAttempts < 2) {
      setShowDismissedWarning(dismissed)
      setForceAttempts(prev => prev + 1)
      setTimeout(() => setShowDismissedWarning(null), 3000)
      return
    }

    // Check for unrecognized mentions
    const unrecognized = getUnrecognizedMentions()
    if (unrecognized.length > 0 && forceAttempts < 2) {
      setShowUnknownError(unrecognized)
      setForceAttempts(prev => prev + 1)
      setTimeout(() => setShowUnknownError(null), 3000)
      return
    }

    // Send normally
    const leadingMentions = value.match(/^(@[\w-]+\s*)+/)?.[0]?.trim() || ''
    onSend(value.trim())
    setValue(leadingMentions ? leadingMentions + ' ' : '')
    setForceAttempts(0)
    setShowUnknownError(null)
    setShowDismissedWarning(null)
  }

  return (
    <div className="border-t p-3">
      {/* Roster display */}
      {activeRoster.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 mb-2 text-xs">
          {activeRoster.map(agent => {
            const state = agentStateMap.get(agent.name.toLowerCase())
            const colorClass = state ? STATE_TEXT_COLORS[state] || 'text-muted-foreground' : 'text-muted-foreground/50'
            return (
              <span
                key={agent.name}
                className={cn(colorClass)}
                title={state || 'inactive'}
              >
                @{agent.name}
              </span>
            )
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="relative">
            <Textarea
              ref={inputRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${activeRoster[0]?.name || 'the channel'} (or @mention someone)`}
              rows={1}
              autoFocus
              className={cn(
                'resize-none overflow-hidden pr-10',
                (showUnknownError || showDismissedWarning) && 'border-yellow-500 animate-pulse'
              )}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={trySend}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </PopoverTrigger>
        <PopoverContent
          className={cn("p-1", suggestions[0]?.type === 'command' ? "w-[350px]" : "w-[280px]")}
          align="start"
          side="top"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="space-y-0.5">
            {suggestions.map((s, i) => (
              <button
                key={s.name}
                onClick={() => completeSuggestion(s)}
                className={cn(
                  "w-full text-left px-2 py-1.5 text-sm rounded flex items-center justify-between gap-2",
                  i === selectedIndex ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
                )}
              >
                <span>{s.type === 'command' ? '/' : '@'}{s.name}</span>
                {s.description && (
                  <span className={cn(
                    "text-xs truncate",
                    i === selectedIndex ? "text-primary-foreground/70" : "text-muted-foreground"
                  )}>
                    {s.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {showDismissedWarning && (
        <p className="text-yellow-500 text-xs mt-1 animate-pulse">
          Dismissed: {showDismissedWarning.map(n => `@${n}`).join(', ')} — press Enter again to re-summon
        </p>
      )}
      {showUnknownError && (
        <p className="text-yellow-500 text-xs mt-1 animate-pulse">
          Unknown: {showUnknownError.map(n => `@${n}`).join(', ')} — press Enter again to send anyway
        </p>
      )}
    </div>
  )
})
