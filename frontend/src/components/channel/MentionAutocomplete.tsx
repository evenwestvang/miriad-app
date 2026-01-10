import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'
import { getSenderColor } from '../../utils'

export interface RosterAgent {
  callsign: string
  /** Whether agent has a callbackUrl (container is running) */
  isOnline: boolean
  /** Whether agent container is starting up */
  isConnecting?: boolean
  /** Whether agent is in an active turn (sent messages, no idle frame yet) */
  isWorking?: boolean
  /** Whether agent is paused (explicitly paused by user) */
  isPaused?: boolean
  /** Tunnel hash for HTTP exposure (32-char hex, generated on spawn) */
  tunnelHash?: string
  /** Agent type/definition slug (e.g., "engineer", "lead") for visual identification */
  agentType?: string
  /** ISO timestamp of last heartbeat (for client-side offline timeout tracking) */
  lastHeartbeat?: string
  /** Session cost in USD (accumulated from cost frames) */
  sessionCost?: number
}

interface MentionAutocompleteProps {
  query: string
  roster: RosterAgent[]
  selectedIndex: number
  onSelect: (mention: string) => void
  onClose: () => void
  position: { top: number; left: number }
}

// Get status display info from agent state
function getAgentStatusInfo(agent: RosterAgent): { colorClass: string; label: string } {
  if (agent.isPaused) {
    return { colorClass: 'bg-gray-400', label: 'paused' }
  }
  if (agent.isConnecting) {
    return { colorClass: 'bg-yellow-500 animate-pulse', label: 'connecting' }
  }
  if (!agent.isOnline) {
    return { colorClass: 'bg-gray-500', label: 'offline' }
  }
  if (agent.isWorking) {
    return { colorClass: 'bg-blue-500 animate-pulse', label: 'working' }
  }
  return { colorClass: 'bg-green-500', label: 'idle' }
}

export function MentionAutocomplete({
  query,
  roster,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Filter options based on query
  const filteredOptions = getFilteredOptions(query, roster)

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

  if (filteredOptions.length === 0) {
    return null
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px] max-h-[200px] overflow-y-auto"
      style={{ bottom: position.top, left: position.left }}
    >
      {filteredOptions.map((option, index) => (
        <button
          key={option.value}
          data-selected={index === selectedIndex}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
            "hover:bg-secondary/50 transition-colors",
            index === selectedIndex && "bg-secondary"
          )}
          onClick={() => onSelect(option.value)}
        >
          {option.type === 'channel' ? (
            <>
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              <span className="font-medium text-purple-400">@channel</span>
              <span className="text-muted-foreground text-xs ml-auto">broadcast</span>
            </>
          ) : (
            (() => {
              const statusInfo = option.agent ? getAgentStatusInfo(option.agent) : { colorClass: 'bg-gray-500', label: 'offline' }
              const isPaused = option.agent?.isPaused
              return (
                <>
                  <span className={cn("w-2 h-2 rounded-full", statusInfo.colorClass)} />
                  <span className={cn(
                    "font-medium",
                    getSenderColor(option.value),
                    isPaused && "line-through opacity-60"
                  )}>
                    @{option.value}
                  </span>
                  <span className="text-muted-foreground text-xs ml-auto">
                    {statusInfo.label}
                  </span>
                </>
              )
            })()
          )}
        </button>
      ))}
    </div>
  )
}

interface FilteredOption {
  type: 'agent' | 'channel'
  value: string
  agent?: RosterAgent
}

function getFilteredOptions(query: string, roster: RosterAgent[]): FilteredOption[] {
  const lowerQuery = query.toLowerCase()
  const options: FilteredOption[] = []

  // Always include @channel option if it matches
  if ('channel'.startsWith(lowerQuery)) {
    options.push({ type: 'channel', value: 'channel' })
  }

  // Filter roster agents
  for (const agent of roster) {
    if (agent.callsign.toLowerCase().startsWith(lowerQuery)) {
      options.push({
        type: 'agent',
        value: agent.callsign,
        agent,
      })
    }
  }

  return options
}

/**
 * Hook to manage mention autocomplete state
 */
export function useMentionAutocomplete(roster: RosterAgent[]) {
  // Find mention trigger in text
  const findMentionTrigger = (text: string, cursorPos: number): { start: number; query: string } | null => {
    // Look backwards from cursor for @ that starts a mention
    let start = cursorPos - 1
    while (start >= 0) {
      const char = text[start]
      if (char === '@') {
        const query = text.slice(start + 1, cursorPos)
        // Only trigger if query is valid (alphanumeric)
        if (/^\w*$/.test(query)) {
          return { start, query }
        }
        return null
      }
      // Stop if we hit whitespace or non-word char before @
      if (!/\w/.test(char)) {
        return null
      }
      start--
    }
    return null
  }

  // Get filtered options count for a query
  const getOptionsCount = (query: string): number => {
    return getFilteredOptions(query, roster).length
  }

  // Get option at index
  const getOptionAtIndex = (query: string, index: number): string | null => {
    const options = getFilteredOptions(query, roster)
    return options[index]?.value ?? null
  }

  return {
    findMentionTrigger,
    getOptionsCount,
    getOptionAtIndex,
  }
}
