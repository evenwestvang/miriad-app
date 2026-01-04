import { useState, useEffect } from 'react'
import { Plus, Bot } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fetchAgentTypes, AgentType } from '@/api'

interface AddAgentButtonProps {
  channel: string
  onInsert: (text: string) => void
}

export function AddAgentButton({ channel, onInsert }: AddAgentButtonProps) {
  const [open, setOpen] = useState(false)
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && agentTypes.length === 0) {
      setLoading(true)
      fetchAgentTypes(channel)
        .then(res => setAgentTypes(res.availableAgents))
        .catch(() => setAgentTypes([]))
        .finally(() => setLoading(false))
    }
  }, [open, channel, agentTypes.length])

  const handleSelect = (slug: string) => {
    onInsert(`@+${slug} `)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border bg-background rounded-full px-2.5 py-1 hover:border-primary/50 transition-colors shadow-sm"
          title="Add agent"
        >
          <Plus className="h-3 w-3" />
          <span>Add agent</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="end">
        {loading ? (
          <div className="text-xs text-muted-foreground px-2 py-3 text-center">
            Loading...
          </div>
        ) : agentTypes.length === 0 ? (
          <div className="text-xs text-muted-foreground px-2 py-3 text-center">
            No agent types available
          </div>
        ) : (
          <div className="max-h-48 overflow-y-auto">
            {agentTypes.map(agent => (
              <button
                key={agent.slug}
                onClick={() => handleSelect(agent.slug)}
                className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-secondary flex items-center gap-2"
              >
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
