import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '../../lib/utils'

/** A global agent configured at space level (Chorus protocol) */
export interface GlobalAgent {
  /** Agent callsign (unique within space) */
  name: string
  /** Protocol used to reach this agent */
  protocol: 'chorus'
  /** Display name (defaults to callsign if not set) */
  displayName?: string
  /** Description of the agent's capabilities */
  description?: string
}

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
  /** Whether this is a global agent (Chorus-backed, not container-based) */
  isGlobal?: boolean
}

interface MentionAutocompleteProps {
  query: string
  roster: RosterAgent[]
  /** Global agents available at space level (shown if not already in roster) */
  globalAgents?: GlobalAgent[]
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
  globalAgents,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Filter options based on query (roster + global agents, deduplicated)
  const filteredOptions = getFilteredOptions(query, roster, globalAgents)

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
            ) : option.type === 'global' ? (
              <>
                <Globe className="w-3.5 h-3.5 text-[var(--cast-text-muted)] shrink-0" />
                <span className="font-medium text-[var(--cast-text-primary)]">
                  {option.globalAgent?.displayName || option.value}
                </span>
                <span className="text-[var(--cast-text-muted)] text-xs ml-auto">global</span>
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
  type: 'agent' | 'channel' | 'global'
  value: string
  agent?: RosterAgent
  globalAgent?: GlobalAgent
}

function getFilteredOptions(query: string, roster: RosterAgent[], globalAgents?: GlobalAgent[]): FilteredOption[] {
  const lowerQuery = query.toLowerCase()
  const options: FilteredOption[] = []

  // Always include @channel option if it matches
  if ('channel'.startsWith(lowerQuery)) {
    options.push({ type: 'channel', value: 'channel' })
  }

  // Filter roster agents
  const rosterCallsigns = new Set<string>()
  for (const agent of roster) {
    rosterCallsigns.add(agent.callsign.toLowerCase())
    if (agent.callsign.toLowerCase().startsWith(lowerQuery)) {
      options.push({
        type: 'agent',
        value: agent.callsign,
        agent,
      })
    }
  }

  // Filter global agents (exclude those already in roster)
  if (globalAgents) {
    for (const ga of globalAgents) {
      if (rosterCallsigns.has(ga.name.toLowerCase())) continue
      if (ga.name.toLowerCase().startsWith(lowerQuery)) {
        options.push({
          type: 'global',
          value: ga.name,
          globalAgent: ga,
        })
      }
    }
  }

  return options
}

/**
 * Hook to manage mention autocomplete state
 */
export function useMentionAutocomplete(roster: RosterAgent[], globalAgents?: GlobalAgent[]) {
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
    return getFilteredOptions(query, roster, globalAgents).length
  }

  // Get option at index
  const getOptionAtIndex = (query: string, index: number): string | null => {
    const options = getFilteredOptions(query, roster, globalAgents)
    return options[index]?.value ?? null
  }

  return {
    findMentionTrigger,
    getOptionsCount,
    getOptionAtIndex,
  }
}
