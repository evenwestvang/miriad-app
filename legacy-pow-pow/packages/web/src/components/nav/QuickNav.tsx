import { useState, useRef, useEffect } from 'react'
import { Hash, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Channel } from '@/types'

// Fuzzy match: returns score (higher is better) or -1 if no match
// Non-contiguous matching: "hd" matches "holodex" (h...d...)
function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  if (q.length === 0) return 1 // Empty query matches everything
  if (q.length > t.length) return -1

  let qi = 0
  let score = 0
  let lastMatchIndex = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      if (lastMatchIndex === ti - 1) score += 2
      // Bonus for matching at start or after separator
      if (ti === 0 || t[ti - 1] === '-' || t[ti - 1] === '_' || t[ti - 1] === ' ') score += 3
      score += 1
      lastMatchIndex = ti
      qi++
    }
  }

  return qi === q.length ? score : -1
}

interface QuickNavProps {
  open: boolean
  onClose: () => void
  channels: Channel[]
  onSelectChannel: (channel: string) => void
  onNewChannel: () => void
}

export function QuickNav({
  open,
  onClose,
  channels,
  onSelectChannel,
  onNewChannel,
}: QuickNavProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Filter and sort channels by fuzzy match score
  const filtered = channels
    .map(ch => ({ channel: ch, score: fuzzyMatch(query, ch.name) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name))
    .map(item => item.channel)

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const handleSelect = (channel: Channel) => {
    onSelectChannel(channel.name)
    onClose()
  }

  const handleNewChannel = () => {
    onNewChannel()
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length)) // +1 for "New channel" option
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedIndex === filtered.length) {
        handleNewChannel()
      } else if (filtered[selectedIndex]) {
        handleSelect(filtered[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-2xl w-full max-w-md overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-3 border-b">
          <Input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search channels..."
            className="bg-transparent border-0 focus-visible:ring-0 text-base"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {filtered.map((channel, i) => (
            <button
              key={channel.name}
              onClick={() => handleSelect(channel)}
              className={cn(
                'w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-secondary/50',
                i === selectedIndex && 'bg-secondary'
              )}
            >
              <Hash className="h-4 w-4 text-muted-foreground" />
              <span>{channel.name}</span>
              {channel.metadata?.tagline && (
                <span className="text-muted-foreground text-sm truncate ml-auto">
                  {channel.metadata.tagline}
                </span>
              )}
            </button>
          ))}
          {/* New channel option */}
          <button
            onClick={handleNewChannel}
            className={cn(
              'w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-secondary/50',
              selectedIndex === filtered.length && 'bg-secondary'
            )}
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
            <span>New channel</span>
            {query && <span className="text-muted-foreground">"{query}"</span>}
          </button>
        </div>
        <div className="p-2 border-t text-xs text-muted-foreground flex items-center gap-4">
          <span><kbd className="px-1.5 py-0.5 bg-secondary rounded text-[10px]">↑↓</kbd> navigate</span>
          <span><kbd className="px-1.5 py-0.5 bg-secondary rounded text-[10px]">↵</kbd> select</span>
          <span><kbd className="px-1.5 py-0.5 bg-secondary rounded text-[10px]">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
