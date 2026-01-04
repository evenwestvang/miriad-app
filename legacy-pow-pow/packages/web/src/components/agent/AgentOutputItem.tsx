import { AgentOutput } from '@/types'
import { ToolBlock } from './ToolBlock'
import { ResultBlock } from './ResultBlock'

interface AgentOutputItemProps {
  item: AgentOutput
}

export function AgentOutputItem({ item }: AgentOutputItemProps) {
  if (item.type === 'tool_call') {
    return <ToolBlock item={item} />
  }

  if (item.type === 'tool_result') {
    return (
      <div className="ml-3 border-l-2 border-border pl-2">
        <ResultBlock content={item.content} />
      </div>
    )
  }

  if (item.type === 'error') {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-600">
        {item.content}
      </div>
    )
  }

  if (item.type === 'system') {
    return (
      <div className="text-xs text-muted-foreground/60 italic">
        {item.content}
      </div>
    )
  }

  if (item.type === 'reasoning') {
    return (
      <div className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300">
        <span className="font-medium">Reasoning: </span>
        {item.content}
      </div>
    )
  }

  // Regular text output - agent thinking/response
  return (
    <div className="text-sm text-foreground whitespace-pre-wrap">
      {item.content}
    </div>
  )
}
