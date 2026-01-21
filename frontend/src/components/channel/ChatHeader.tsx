/**
 * ChatHeader Component
 *
 * Header for the chat panel, similar to BoardHeader structure.
 * Shows "Thread" label with board toggle button and channel cost total.
 */
import { LayoutGrid, PanelLeftClose, PanelLeft, Flame } from 'lucide-react'

interface ChatHeaderProps {
  /** Whether the agent is currently thinking/processing */
  isThinking?: boolean
  /** Whether the board panel is currently open */
  boardOpen?: boolean
  /** Callback to toggle the board panel */
  onToggleBoard?: () => void
  /** Total channel cost in USD (sum of all agent costs) */
  channelCost?: number
  /** Whether the sidebar is currently open */
  sidebarOpen?: boolean
  /** Callback to toggle the sidebar */
  onToggleSidebar?: () => void
  /** Whether firehose mode is enabled (show expanded tool calls) */
  firehoseMode?: boolean
  /** Callback to toggle firehose mode */
  onToggleFirehose?: () => void
}

/**
 * Format cost for display.
 * - 0: show $0.00
 * - < $0.01: show 4 decimal places (e.g., $0.0012)
 * - >= $0.01: show 2 decimal places (e.g., $0.17)
 */
function formatCost(cost: number): string {
  if (cost === 0) {
    return '~$0.00'
  }
  if (cost < 0.01) {
    return `~$${cost.toFixed(4)}`
  }
  return `~$${cost.toFixed(2)}`
}

export function ChatHeader({
  isThinking = false,
  boardOpen = false,
  onToggleBoard,
  channelCost = 0,
  sidebarOpen = true,
  onToggleSidebar,
  firehoseMode = false,
  onToggleFirehose,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between h-10 px-3 border-b border-border">
      <div className="flex items-center gap-2">
        {/* Sidebar toggle - desktop only */}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="hidden md:block p-1.5 rounded hover:bg-secondary/50 transition-colors"
            title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
            ) : (
              <PanelLeft className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        )}
        {isThinking && (
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-blue-500 animate-pulse" />
        )}
        <span className="font-medium text-base text-foreground">Thread</span>
      </div>
      <div className="flex items-center gap-2">
        {/* Channel cost total */}
        <span className="text-xs text-[#a0a0a0]" title="Total channel cost">
          {formatCost(channelCost)}
        </span>
        {/* Firehose mode toggle */}
        {onToggleFirehose && (
          <button
            onClick={onToggleFirehose}
            className={`p-1.5 rounded transition-colors ${
              firehoseMode
                ? 'bg-orange-500/20 text-orange-500 hover:bg-orange-500/30'
                : 'hover:bg-secondary/50 text-muted-foreground'
            }`}
            title="Enable firehose mode"
          >
            <Flame className="w-4 h-4" />
          </button>
        )}
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
