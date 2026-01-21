/**
 * Channel Switcher - Cmd-K quick navigation
 *
 * A command palette style overlay for quickly switching between channels
 * using fuzzy matching on channel names.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Search, Hash } from 'lucide-react'
import { cn } from '../lib/utils'
import type { Thread } from '../types'

interface ChannelSwitcherProps {
  isOpen: boolean
  onClose: () => void
  channels: Thread[]
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
}

/**
 * Simple fuzzy match scoring
 * Returns a score based on how well the query matches the target
 * Higher score = better match
 * Returns -1 if no match
 */
function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Empty query matches everything
  if (!q) return 0

  // Exact match gets highest score
  if (t === q) return 1000

  // Contains as substring gets high score
  if (t.includes(q)) {
    // Bonus for matching at start
    if (t.startsWith(q)) return 500 + (q.length / t.length) * 100
    return 300 + (q.length / t.length) * 100
  }

  // Fuzzy character matching
  let qIdx = 0
  let score = 0
  let consecutive = 0
  let lastMatchIdx = -1

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      // Bonus for consecutive matches
      if (lastMatchIdx === tIdx - 1) {
        consecutive++
        score += consecutive * 10
      } else {
        consecutive = 1
        score += 5
      }

      // Bonus for matching at word boundaries
      if (tIdx === 0 || t[tIdx - 1] === ' ' || t[tIdx - 1] === '-' || t[tIdx - 1] === '_') {
        score += 15
      }

      lastMatchIdx = tIdx
      qIdx++
    }
  }

  // All query characters must be found
  if (qIdx < q.length) return -1

  // Penalize long targets (prefer shorter matches)
  score -= (t.length - q.length) * 0.5

  return Math.max(0, score)
}

export function ChannelSwitcher({
  isOpen,
  onClose,
  channels,
  selectedChannelId,
  onSelectChannel,
}: ChannelSwitcherProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter and sort channels by fuzzy match score
  const filteredChannels = useMemo(() => {
    if (!query.trim()) {
      // No query - show all channels, with selected one first, then by last active
      return [...channels].sort((a, b) => {
        // Selected channel first
        if (a.id === selectedChannelId) return -1
        if (b.id === selectedChannelId) return 1
        // Then by last active
        const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0
        const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0
        return bTime - aTime
      })
    }

    // Score and filter channels
    const scored = channels
      .map(channel => ({
        channel,
        score: fuzzyMatch(query, channel.agentName),
      }))
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score)

    return scored.map(item => item.channel)
  }, [channels, query, selectedChannelId])

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      // Focus input after a brief delay to ensure DOM is ready
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [isOpen])

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= filteredChannels.length) {
      setSelectedIndex(Math.max(0, filteredChannels.length - 1))
    }
  }, [filteredChannels.length, selectedIndex])

  // Scroll selected item into view
  useEffect(() => {
    const selectedEl = listRef.current?.querySelector('[data-selected="true"]')
    selectedEl?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev =>
          prev < filteredChannels.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => prev > 0 ? prev - 1 : prev)
        break
      case 'Enter':
        e.preventDefault()
        if (filteredChannels[selectedIndex]) {
          onSelectChannel(filteredChannels[selectedIndex].id)
          onClose()
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [filteredChannels, selectedIndex, onSelectChannel, onClose])

  const handleSelect = useCallback((channelId: string) => {
    onSelectChannel(channelId)
    onClose()
  }, [onSelectChannel, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Search channels..."
            className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground outline-none text-base"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground bg-muted rounded">
            esc
          </kbd>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          className="max-h-[300px] overflow-y-auto py-2"
        >
          {filteredChannels.length === 0 ? (
            <div className="px-4 py-8 text-center text-base text-muted-foreground">
              No channels found
            </div>
          ) : (
            filteredChannels.map((channel, index) => (
              <button
                key={channel.id}
                data-selected={index === selectedIndex}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-2 text-left transition-colors",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/50"
                )}
                onClick={() => handleSelect(channel.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <Hash className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium truncate">
                    {channel.agentName}
                  </div>
                </div>
                {channel.id === selectedChannelId && (
                  <span className="text-xs text-muted-foreground">current</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border bg-muted/30">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-muted rounded">↑</kbd>
              <kbd className="px-1.5 py-0.5 bg-muted rounded">↓</kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-muted rounded">enter</kbd>
              <span>select</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
