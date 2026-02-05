/**
 * Update Tasks renderer - displays the agent's task list as a todo list.
 *
 * Shows:
 * - Task list with status indicators
 * - Visual distinction between pending, in_progress, completed, blocked
 * - Blocked reason when applicable
 */
import { CheckCircle2, Circle, Loader2, AlertCircle, ListTodo } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

interface Task {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  blockedReason?: string
}

function getStatusIcon(status: Task['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-500" />
    case 'in_progress':
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
    case 'blocked':
      return <AlertCircle className="w-4 h-4 text-red-500" />
    case 'pending':
    default:
      return <Circle className="w-4 h-4 text-muted-foreground" />
  }
}

function getStatusClass(status: Task['status']) {
  switch (status) {
    case 'completed':
      return 'text-muted-foreground line-through'
    case 'in_progress':
      return 'text-foreground font-medium'
    case 'blocked':
      return 'text-red-600 dark:text-red-400'
    case 'pending':
    default:
      return 'text-foreground'
  }
}

export function UpdateTasksRenderer({ args, isSuccess }: ToolRendererProps) {
  const normalized = normalizeArgs(args)
  const tasks = (normalized.tasks as Task[]) || []

  if (tasks.length === 0) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <ListTodo className="w-4 h-4" />
        <span className="text-sm italic">No tasks</span>
      </div>
    )
  }

  // Count by status
  const completed = tasks.filter(t => t.status === 'completed').length
  const inProgress = tasks.filter(t => t.status === 'in_progress').length
  const blocked = tasks.filter(t => t.status === 'blocked').length
  const pending = tasks.filter(t => t.status === 'pending').length

  return (
    <div className={cn(
      "rounded-md border border-border overflow-hidden",
      !isSuccess && "opacity-60"
    )}>
      {/* Header with summary */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border">
        <div className="flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-purple-500" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tasks</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {completed > 0 && <span className="text-green-600 dark:text-green-400">{completed} done</span>}
          {inProgress > 0 && <span className="text-blue-600 dark:text-blue-400">{inProgress} active</span>}
          {blocked > 0 && <span className="text-red-600 dark:text-red-400">{blocked} blocked</span>}
          {pending > 0 && <span>{pending} pending</span>}
        </div>
      </div>
      
      {/* Task list */}
      <div className="divide-y divide-border">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-start gap-2 px-3 py-2">
            <div className="mt-0.5 flex-shrink-0">
              {getStatusIcon(task.status)}
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn("text-sm", getStatusClass(task.status))}>
                {task.content}
              </p>
              {task.blockedReason && (
                <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">
                  Blocked: {task.blockedReason}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
