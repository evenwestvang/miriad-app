import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'

export interface RosterAgent {
  callsign: string
  /** Whether the agent's runtime is online (agent can receive messages) */
  isOnline: boolean
  /** Whether agent is in an active turn (sent messages, no idle frame yet) */
  isWorking?: boolean
  /** Whether agent is pending (message routed, awaiting first frame) */
  isPending?: boolean
  /** Whether agent is paused (explicitly paused by user) */
  isPaused?: boolean
  /** Tunnel hash for HTTP exposure (32-char hex, generated on spawn) */
  tunnelHash?: string
  /** Agent type/definition slug (e.g., "engineer", "lead") for visual identification */
  agentType?: string
  /** ISO timestamp of last heartbeat (for client-side offline timeout tracking) */
  lastHeartbeat?: string
  /** ISO timestamp of when a message was last routed (for client-side pending timeout tracking) */
  lastMessageRoutedAt?: string
  /** Session cost in USD (accumulated from cost frames) */
  sessionCost?: number
  /** Current agent state from set_status calls */
  current?: {
    status?: string
  }
  /** Runtime ID if agent is bound to a local runtime (null = cloud) */
  runtimeId?: string | null
  /** Runtime name for display (populated from runtime record) */
  runtimeName?: string
  /** Runtime connection status - agent is online when runtime is online */
  runtimeStatus?: 'online' | 'offline'
}

interface MentionAutocompleteProps {
  query: string
  roster: RosterAgent[]
  selectedIndex: number
  onSelect: (mention: string) => void
  onClose: () => void
  position: { top: number; left: number }
  /** Channel ID for computing coordinated colors */
  channelId?: string
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
      className="absolute z-50 bg-card border border-[var(--cast-border-default)] shadow-sm py-1 min-w-[180px] max-h-[200px] overflow-y-auto"
      style={{ bottom: position.top, left: position.left }}
    >
      {filteredOptions.map((option, index) => {
        return (
          <button
            key={option.value}
            data-selected={index === selectedIndex}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
              "hover:bg-[var(--cast-bg-secondary)] transition-colors",
              index === selectedIndex && "bg-[var(--cast-bg-secondary)]"
            )}
            onClick={() => onSelect(option.value)}
          >
            {option.type === 'channel' ? (
              <>
                <span className="font-medium text-[var(--cast-text-primary)]">channel</span>
                <span className="text-[var(--cast-text-muted)] text-xs ml-auto">broadcast</span>
              </>
            ) : (
              <>
                <span className={cn(
                  "font-medium text-[var(--cast-text-primary)]",
                  option.agent?.isPaused && "line-through opacity-60"
                )}>
                  {option.value}
                </span>
                {option.agent?.agentType && (
                  <span className="text-[var(--cast-text-muted)] text-xs ml-auto">
                    {option.agent.agentType}
                  </span>
                )}
              </>
            )}
          </button>
        )
      })}
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
