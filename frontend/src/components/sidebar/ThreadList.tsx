import { useState, useRef } from 'react'
import { Plus, Radical } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Agent, Thread } from '../../types'
import { NewChannelModal } from '../focus'
import { SanityLogo } from '../icons/SanityLogo'

// Thread with extended state info
export interface ThreadWithState extends Thread {
  agentType?: string
  agentState?: 'starting' | 'idle' | 'thinking' | 'tool_running' | 'stopped' | 'error'
}

interface ThreadListProps {
  threads: ThreadWithState[]
  agents: Agent[]
  selectedThread: string | null
  isCreatingThread?: boolean
  onSelectThread: (threadId: string) => void
  onCreateThread: (agentId: string, name?: string) => void
  onCreateChannel?: (name: string, focusSlug: string | null) => Promise<void>
  apiHost?: string
}

interface SpawnDialogProps {
  agents: Agent[]
  isOpen: boolean
  onClose: () => void
  onCreate: (agentId: string, name?: string) => void
}

function SpawnDialog({ agents, isOpen, onClose, onCreate }: SpawnDialogProps) {
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [threadName, setThreadName] = useState('')

  if (!isOpen) return null

  const handleCreate = () => {
    if (!selectedAgentId) return
    onCreate(selectedAgentId, threadName || undefined)
    setSelectedAgentId('')
    setThreadName('')
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter' && selectedAgentId) {
      handleCreate()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative bg-card border border-border rounded-lg p-4 w-80 shadow-lg"
        onKeyDown={handleKeyDown}
      >
        <h3 className="text-base font-semibold text-foreground mb-4">New Thread</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Agent Type
            </label>
            <select
              className="w-full px-3 py-2 bg-secondary text-foreground text-base rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              autoFocus
            >
              <option value="">Select agent type</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Name (optional)
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 bg-secondary text-foreground text-base rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
              placeholder="e.g., My Assistant"
              value={threadName}
              onChange={(e) => setThreadName(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            className="px-3 py-1.5 text-base text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={cn(
              'px-3 py-1.5 text-base rounded-md transition-colors',
              selectedAgentId
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-secondary text-muted-foreground cursor-not-allowed'
            )}
            onClick={handleCreate}
            disabled={!selectedAgentId}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

export function ThreadList({
  threads,
  agents,
  selectedThread,
  isCreatingThread,
  onSelectThread,
  onCreateThread,
  onCreateChannel,
  apiHost = '',
}: ThreadListProps) {
  const [showSpawnDialog, setShowSpawnDialog] = useState(false)
  const [showNewChannelModal, setShowNewChannelModal] = useState(false)
  const newChannelButtonRef = useRef<HTMLButtonElement>(null)

  // Use new channel modal if onCreateChannel is provided
  const handleNewClick = () => {
    if (onCreateChannel) {
      setShowNewChannelModal(true)
    } else {
      setShowSpawnDialog(true)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <button
          ref={newChannelButtonRef}
          className="flex items-center gap-1.5 px-0 py-1.5 text-base text-[#8c8c8c] hover:text-[#1a1a1a] dark:hover:text-[#f5f5f5] transition-colors mb-2"
          onClick={handleNewClick}
          title="New channel"
        >
          <Plus className="w-3 h-3" strokeWidth={2.5} />
          <span>New Channel</span>
        </button>
        <span className="text-[11px] font-medium text-[#8c8c8c] uppercase tracking-[0.05em]">
          Channels
        </span>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto py-1">
        {threads.length === 0 && !isCreatingThread ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <p className="text-muted-foreground text-base mb-2">No threads yet</p>
            <button
              className="flex items-center gap-1 px-3 py-1.5 text-base border border-border rounded-md hover:bg-secondary/50 transition-colors"
              onClick={handleNewClick}
            >
              <Plus className="w-4 h-4" />
              Create your first channel
            </button>
          </div>
        ) : (
          <>
            {/* Regular channels */}
            <ul className="space-y-0">
              {isCreatingThread && (
                <li className="flex items-center gap-2 px-4 py-1.5 bg-[var(--cast-bg-hover)]">
                  <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                  <span className="text-base text-[var(--cast-text-muted)]">Creating...</span>
                </li>
              )}
              {threads.filter(t => t.agentName !== 'root').map((thread) => (
                <li key={thread.id}>
                  <button
                    className={cn(
                      'w-full flex items-center gap-2 px-4 py-1.5 cursor-pointer text-left transition-colors',
                      'hover:bg-[var(--cast-bg-hover)]',
                      selectedThread === thread.id
                        ? 'bg-[var(--cast-bg-active)] text-[var(--cast-text-primary)] font-medium'
                        : 'text-[var(--cast-text-secondary)]'
                    )}
                    onClick={() => onSelectThread(thread.id)}
                  >
                    <span className="text-[var(--cast-text-subtle)]">#</span>
                    <span className="text-base truncate">
                      {thread.agentName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {/* Root channel separator and item */}
            {threads.find(t => t.agentName === 'root') && (
              <>
                <div className="px-4 py-2">
                  <span className="text-[var(--cast-text-subtle)]">—</span>
                </div>
                {threads.filter(t => t.agentName === 'root').map((thread) => (
                  <button
                    key={thread.id}
                    className={cn(
                      'w-full flex items-center gap-2 px-4 py-1.5 cursor-pointer text-left transition-colors',
                      'hover:bg-[var(--cast-bg-hover)]',
                      selectedThread === thread.id
                        ? 'bg-[var(--cast-bg-active)] text-[var(--cast-text-primary)] font-medium'
                        : 'text-[var(--cast-text-secondary)]'
                    )}
                    onClick={() => onSelectThread(thread.id)}
                  >
                    <Radical className="w-3 h-3 text-[var(--cast-text-subtle)]" />
                    <span className="text-base truncate">
                      {thread.agentName}
                    </span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Spawn dialog (legacy) */}
      <SpawnDialog
        agents={agents}
        isOpen={showSpawnDialog}
        onClose={() => setShowSpawnDialog(false)}
        onCreate={onCreateThread}
      />

      {/* New channel popover */}
      {onCreateChannel && (
        <NewChannelModal
          isOpen={showNewChannelModal}
          onClose={() => setShowNewChannelModal(false)}
          onCreate={onCreateChannel}
          apiHost={apiHost}
          anchorRef={newChannelButtonRef}
        />
      )}

      {/* Footer */}
      <a
        href="https://sanity.io"
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-end gap-1 px-4 py-3 text-xs text-[var(--cast-text-subtle)] hover:text-[var(--cast-text-secondary)] transition-colors"
      >
        <span>Experiment from</span>
        <SanityLogo className="h-3.5 opacity-50" />
      </a>
    </div>
  )
}
