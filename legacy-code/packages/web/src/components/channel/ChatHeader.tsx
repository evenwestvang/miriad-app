/**
 * ChatHeader Component
 *
 * Header for the chat panel, similar to BoardHeader structure.
 * Shows "Thread" label with board toggle button.
 */
import { LayoutGrid } from 'lucide-react'

interface ChatHeaderProps {
  /** Whether the agent is currently thinking/processing */
  isThinking?: boolean
  /** Whether the board panel is currently open */
  boardOpen?: boolean
  /** Callback to toggle the board panel */
  onToggleBoard?: () => void
}

export function ChatHeader({
  isThinking = false,
  boardOpen = false,
  onToggleBoard,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between h-10 px-3 border-b border-border">
      <div className="flex items-center gap-2">
        {isThinking && (
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-blue-500 animate-pulse" />
        )}
        <span className="font-medium text-sm text-foreground">Thread</span>
      </div>
      <div className="flex items-center gap-1">
        {/* Board toggle - hidden when board is open (close button takes its place) */}
        {!boardOpen && onToggleBoard && (
          <button
            onClick={onToggleBoard}
            className="p-1.5 rounded hover:bg-secondary/50 transition-colors"
            title="Open board"
          >
            <LayoutGrid className="w-4 h-4 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  )
}
