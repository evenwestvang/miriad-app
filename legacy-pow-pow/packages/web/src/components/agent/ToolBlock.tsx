import { Send, Square, CheckSquare, FileText, Terminal, Search, FilePen, FileCode, FolderSearch } from 'lucide-react'
import { AgentOutput } from '@/types'
import { MessageContent } from '@/components/channel/MessageContent'
import { DiffBlock } from './DiffBlock'

interface ToolBlockProps {
  item: AgentOutput
}

export function ToolBlock({ item }: ToolBlockProps) {
  const rawToolName = item.toolName || 'unknown'
  const toolName = rawToolName.replace('mcp__powpow__', '').replace('mcp__', '')
  const input = item.toolInput as Record<string, unknown> | undefined

  // PowPow action tools - render as actions
  const isSendMessage = toolName === 'send_message'
  const isSetStatus = toolName === 'set_status'
  const isTodoWrite = toolName === 'TodoWrite'

  // Code tools
  const isEdit = toolName === 'Edit'
  const isBash = toolName === 'Bash'
  const isRead = toolName === 'Read'
  const isGrep = toolName === 'Grep'
  const isGlob = toolName === 'Glob'
  const isWrite = toolName === 'Write'

  const filePath = (input?.file_path || input?.path) as string | undefined
  const pattern = input?.pattern as string | undefined

  // Render send_message like a chat message
  if (isSendMessage && input?.content) {
    return (
      <div className="rounded border border-blue-500/30 bg-blue-500/10 overflow-hidden">
        <div className="px-2 py-1 flex items-center gap-2 border-b border-blue-500/30 bg-blue-500/15 text-xs">
          <Send className="w-3 h-3 text-blue-500" />
          <span className="text-blue-600">Posted in</span>
          <span className="font-medium text-blue-600">#{input.channel as string || 'channel'}</span>
        </div>
        <div className="px-3 py-2 text-sm">
          <MessageContent content={input.content as string} myName="" />
        </div>
      </div>
    )
  }

  // Render set_status as a status update
  if (isSetStatus && input?.status) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        <span>{input.status as string}</span>
      </div>
    )
  }

  // Render TodoWrite as todo update
  if (isTodoWrite && input?.todos) {
    const todos = input.todos as Array<{ content: string; status: string }>

    return (
      <div className="rounded border border-yellow-500/30 bg-yellow-500/10 overflow-hidden text-xs">
        <div className="px-2 py-1">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              {todo.status === 'completed' ? (
                <CheckSquare className="w-3 h-3 text-green-500" />
              ) : (
                <Square className="w-3 h-3 text-muted-foreground" />
              )}
              <span className={todo.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const getIcon = () => {
    if (isEdit) return <FilePen className="w-3 h-3" />
    if (isBash) return <Terminal className="w-3 h-3" />
    if (isRead) return <FileText className="w-3 h-3" />
    if (isGrep) return <Search className="w-3 h-3" />
    if (isGlob) return <FolderSearch className="w-3 h-3" />
    if (isWrite) return <FileCode className="w-3 h-3" />
    return <FileText className="w-3 h-3" />
  }

  return (
    <div className="rounded border border-purple-500/30 bg-purple-500/10 overflow-hidden text-xs">
      <div className="px-2 py-1 flex items-center gap-2 border-b border-purple-500/30 bg-purple-500/15">
        <span className="text-purple-500">{getIcon()}</span>
        <span className="font-medium text-purple-600">{toolName}</span>
        {filePath && (
          <span className="text-muted-foreground truncate flex-1 text-right font-mono">{filePath}</span>
        )}
        {pattern && !filePath && (
          <span className="text-muted-foreground truncate flex-1 text-right font-mono">{pattern}</span>
        )}
      </div>

      {isEdit && input?.old_string !== undefined && input?.new_string !== undefined && (
        <DiffBlock oldStr={input.old_string as string} newStr={input.new_string as string} />
      )}

      {isBash && input?.command && (
        <div className="px-2 py-1 font-mono bg-black/20">
          <span className="text-muted-foreground">$ </span>
          <span className="text-foreground">{input.command as string}</span>
        </div>
      )}

      {isWrite && input?.content && (
        <pre className="px-2 py-1 font-mono text-muted-foreground max-h-32 overflow-y-auto">
          {(input.content as string).slice(0, 500)}
          {(input.content as string).length > 500 && '...'}
        </pre>
      )}
    </div>
  )
}
