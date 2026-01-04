import { useState } from 'react'
import { ChevronRight, ChevronDown, Wrench, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Message } from '../../types'

interface ToolMessageProps {
  message: Message
}

export function ToolMessage({ message }: ToolMessageProps) {
  const [expanded, setExpanded] = useState(false)

  if (message.type === 'tool_call') {
    return <ToolCallMessage message={message} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
  }

  if (message.type === 'tool_result') {
    return <ToolResultMessage message={message} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
  }

  return null
}

interface ToolCallMessageProps {
  message: Message
  expanded: boolean
  onToggle: () => void
}

function ToolCallMessage({ message, expanded, onToggle }: ToolCallMessageProps) {
  const toolName = message.toolName || 'Unknown tool'
  const args = message.toolArgs || {}
  const argsPreview = formatArgsPreview(toolName, args)

  return (
    <div className="ml-4 my-1">
      <button
        onClick={onToggle}
        className={cn(
          "flex items-center gap-2 w-full text-left px-3 py-2 rounded-md",
          "bg-secondary/40 hover:bg-secondary/60 transition-colors",
          "border-l-2 border-blue-500"
        )}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
        <Wrench className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        <span className="font-medium text-sm text-blue-400">{toolName}</span>
        {argsPreview && (
          <span className="text-xs text-muted-foreground font-mono truncate">{argsPreview}</span>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mt-1 px-3 py-2 bg-secondary/20 rounded-md border-l-2 border-blue-500/50">
          <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

interface ToolResultMessageProps {
  message: Message
  expanded: boolean
  onToggle: () => void
}

function ToolResultMessage({ message, expanded, onToggle }: ToolResultMessageProps) {
  const isSuccess = message.toolResultStatus !== 'error'
  const output = message.toolResultOutput
  const error = message.toolResultError
  const displayContent = error || (typeof output === 'string' ? output : JSON.stringify(output, null, 2))
  const truncatedContent = truncateOutput(displayContent || '', 100)

  return (
    <div className="ml-4 my-1">
      <button
        onClick={onToggle}
        className={cn(
          "flex items-center gap-2 w-full text-left px-3 py-2 rounded-md",
          "bg-secondary/40 hover:bg-secondary/60 transition-colors",
          isSuccess ? "border-l-2 border-green-500" : "border-l-2 border-red-500"
        )}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
        {isSuccess ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
        )}
        <span className={cn("font-medium text-sm", isSuccess ? "text-green-400" : "text-red-400")}>
          {isSuccess ? 'Result' : 'Error'}
        </span>
        {!expanded && truncatedContent && (
          <span className="text-xs text-muted-foreground font-mono truncate">{truncatedContent}</span>
        )}
      </button>
      {expanded && (
        <div className={cn(
          "ml-5 mt-1 px-3 py-2 bg-secondary/20 rounded-md",
          isSuccess ? "border-l-2 border-green-500/50" : "border-l-2 border-red-500/50"
        )}>
          <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
            {displayContent || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  )
}

// Format args preview based on tool type
function formatArgsPreview(toolName: string, args: Record<string, unknown>): string {
  const name = toolName.toLowerCase()

  if (name === 'read_file' || name === 'read') {
    return (args.path as string) || (args.file_path as string) || ''
  }
  if (name === 'write_file' || name === 'write') {
    return (args.path as string) || (args.file_path as string) || ''
  }
  if (name === 'run_bash' || name === 'bash') {
    const cmd = (args.command as string) || ''
    return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd
  }
  if (name === 'list_files' || name === 'glob') {
    return (args.path as string) || (args.pattern as string) || '.'
  }
  if (name === 'grep') {
    return (args.pattern as string) || ''
  }

  // Default: show first string value
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 50 ? value.slice(0, 50) + '...' : value
    }
  }
  return ''
}

function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output
  return output.slice(0, maxLength) + '...'
}
