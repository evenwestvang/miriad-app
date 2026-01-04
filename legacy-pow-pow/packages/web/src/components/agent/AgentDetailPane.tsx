import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { Agent, AgentOutput } from '@/types'
import { fetchAgentOutput } from '@/api'
import { cn } from '@/lib/utils'
import { STATE_COLORS, STATE_LABELS } from '@/lib/constants'
import { AgentOutputItem } from './AgentOutputItem'

interface AgentDetailPaneProps {
  channel: string
  agentName: string
  agents: Agent[]
}

export function AgentDetailPane({
  channel,
  agentName,
  agents,
}: AgentDetailPaneProps) {
  const [agentOutput, setAgentOutput] = useState<AgentOutput[]>([])
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const prevOutputLengthRef = useRef(0)

  const agent = agents.find(a => a.channel === channel && a.name === agentName)

  // Fetch agent output
  useEffect(() => {
    const loadOutput = async () => {
      setLoading(true)
      const output = await fetchAgentOutput(channel, agentName, 200)
      setAgentOutput(output)
      setLoading(false)
    }

    loadOutput()
    const interval = setInterval(loadOutput, 2000)
    return () => clearInterval(interval)
  }, [channel, agentName])

  // Track scroll position
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    wasAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20
  }, [])

  // Auto-scroll: if was at bottom, snap to bottom immediately
  useLayoutEffect(() => {
    if (agentOutput.length === 0) return
    if (prevOutputLengthRef.current === 0 || wasAtBottomRef.current) {
      const container = containerRef.current
      if (container) {
        container.scrollTop = container.scrollHeight
      }
      wasAtBottomRef.current = true
    }
    prevOutputLengthRef.current = agentOutput.length
  }, [agentOutput])

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Status bar */}
      <div className="px-3 py-1.5 border-b flex items-center gap-2 shrink-0">
        {agent && (
          <>
            <span className={cn(
              'text-[10px] font-medium px-1.5 py-0.5 rounded',
              agent.engine === 'codex' ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'
            )}>
              {agent.engine || 'claude'}
            </span>
            <span className={cn('w-2 h-2 rounded-full', STATE_COLORS[agent.state])} />
            <span className={cn(
              'text-sm',
              agent.state === 'error' ? 'text-destructive' :
              agent.state === 'thinking' ? 'text-blue-500' :
              agent.state === 'tool_running' ? 'text-purple-500' :
              'text-muted-foreground'
            )}>
              {agent.status || STATE_LABELS[agent.state]}
            </span>
            {agent.pendingMessages && agent.pendingMessages > 0 && (
              <span className="text-[10px] text-yellow-400 ml-auto">
                {agent.pendingMessages} pending
              </span>
            )}
          </>
        )}
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0"
      >
        <div className="p-3 space-y-3">
          {loading && agentOutput.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">Loading...</div>
          ) : agentOutput.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">No output yet</div>
          ) : (
            agentOutput.map((item, i) => (
              <AgentOutputItem key={i} item={item} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
