import { useState } from 'react'
import { Hash, Bot, Plus, ChevronRight, ChevronDown, Flame, Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { STATE_COLORS } from '@/lib/constants'
import { Channel, Agent } from '@/types'

interface ChannelListProps {
  channels: Channel[]
  currentChannel: string | null
  agents: Agent[]
  workspaces: { channel: string; name: string }[]
  onSelect: (name: string) => void
  onSelectAgent: (channel: string, name: string) => void
  onFocusFirehose: (agentName: string) => void
  onArchive: (channel: string) => void
  selectedAgent: { channel: string; name: string } | null
  onNewChannel: () => void
}

export function ChannelList({
  channels,
  currentChannel,
  agents,
  workspaces,
  onSelect,
  onSelectAgent,
  onFocusFirehose,
  onArchive,
  selectedAgent,
  onNewChannel,
}: ChannelListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draggedChannel, setDraggedChannel] = useState<string | null>(null)
  const [channelOrder, setChannelOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('powpow-channel-order')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  // Sort channels by stored order, new channels go to the end
  const sortedChannels = [...channels].sort((a, b) => {
    const aIndex = channelOrder.indexOf(a.name)
    const bIndex = channelOrder.indexOf(b.name)
    if (aIndex === -1 && bIndex === -1) return 0
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })

  const handleDragStart = (e: React.DragEvent, channelName: string) => {
    setDraggedChannel(channelName)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, channelName: string) => {
    e.preventDefault()
    if (!draggedChannel || draggedChannel === channelName) return

    const newOrder = sortedChannels.map(c => c.name)
    const draggedIndex = newOrder.indexOf(draggedChannel)
    const targetIndex = newOrder.indexOf(channelName)

    newOrder.splice(draggedIndex, 1)
    newOrder.splice(targetIndex, 0, draggedChannel)

    setChannelOrder(newOrder)
    localStorage.setItem('powpow-channel-order', JSON.stringify(newOrder))
  }

  const handleDragEnd = () => {
    setDraggedChannel(null)
  }

  const toggleExpand = (channelName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(channelName)) {
        next.delete(channelName)
      } else {
        next.add(channelName)
      }
      return next
    })
  }

  const getChannelAgents = (channelName: string) => {
    return agents.filter(a => a.channel === channelName)
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-2">
          <Button
            onClick={onNewChannel}
            variant="ghost"
            className="w-full justify-start text-muted-foreground mb-1"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Channel
          </Button>
          <div className="text-xs text-muted-foreground uppercase px-2 py-1 font-medium">Channels</div>
          {sortedChannels.map((ch) => {
            const channelAgents = getChannelAgents(ch.name)
            const isExpanded = expanded.has(ch.name)
            const hasAgents = channelAgents.length > 0
            const isDragging = draggedChannel === ch.name

            return (
              <div
                key={ch.name}
                className={cn(isDragging && 'opacity-50', 'group/channel')}
              >
                <div className="flex items-center gap-0.5 mb-0.5">
                  {hasAgents && (
                    <span
                      onClick={(e) => toggleExpand(ch.name, e)}
                      className="p-1 hover:bg-black/20 rounded cursor-pointer"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </span>
                  )}
                  <Button
                    draggable
                    onDragStart={(e) => handleDragStart(e, ch.name)}
                    onDragOver={(e) => handleDragOver(e, ch.name)}
                    onDragEnd={handleDragEnd}
                    onClick={() => onSelect(ch.name)}
                    variant={currentChannel === ch.name ? 'secondary' : 'ghost'}
                    className={cn(
                      'flex-1 justify-start gap-1 pr-2 cursor-grab active:cursor-grabbing',
                      currentChannel === ch.name && 'bg-primary text-primary-foreground hover:bg-primary/90'
                    )}
                  >
                    {!hasAgents && <Hash className="h-4 w-4" />}
                    <span className="flex-1 text-left">{ch.name}</span>
                    {hasAgents && (
                      <span className={cn(
                        'text-xs tabular-nums',
                        currentChannel === ch.name ? 'text-primary-foreground/70' : 'text-muted-foreground'
                      )}>
                        {channelAgents.length}
                      </span>
                    )}
                  </Button>
                  {/* Archive button - only show when no live agents */}
                  {!hasAgents && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onArchive(ch.name)
                      }}
                      className="opacity-0 group-hover/channel:opacity-100 p-1.5 text-muted-foreground hover:text-foreground transition-opacity"
                      title="Archive channel"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {isExpanded && hasAgents && (
                  <div
                    className="ml-4 mb-1 space-y-0.5"
                    onDragOver={(e) => e.stopPropagation()}
                  >
                    {channelAgents.map(agent => (
                      <div
                        key={agent.name}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 text-xs rounded group",
                          selectedAgent?.channel === ch.name && selectedAgent?.name === agent.name
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-secondary"
                        )}
                      >
                        <button
                          onClick={() => onSelectAgent(ch.name, agent.name)}
                          className="flex-1 flex items-center gap-2 text-left min-w-0"
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATE_COLORS[agent.state])} />
                          <span className="truncate">{agent.name}</span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onFocusFirehose(agent.name)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-orange-500 transition-opacity"
                          title="View in firehose"
                        >
                          <Flame className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
