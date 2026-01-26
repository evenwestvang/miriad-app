import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '../../lib/utils'
import type { Message, StructuredAskFormData, StructuredAskMessage } from '../../types'
import { StructuredAskForm } from '../structured-ask/StructuredAskForm'
import type { RosterAgent } from './MentionAutocomplete'
import { getPendingAsks } from '../../lib/api'

interface PendingAsksIndicatorProps {
  /** Channel ID to fetch pending asks for */
  channelId: string
  /** Messages from real-time updates (for reactive updates) */
  messages: Message[]
  /** Space ID for runtime lookup in summon fields */
  spaceId?: string
  /** Roster for runtime lookup */
  roster?: RosterAgent[]
  /** Called when a form is submitted */
  onSubmit?: (messageId: string, response: Record<string, unknown>) => void
  /** Called when a form is cancelled */
  onCancel?: (messageId: string) => void
}

/**
 * Transform a raw message to StructuredAskMessage format.
 * Handles both already-transformed messages and raw API responses.
 */
function transformToStructuredAsk(m: Message): StructuredAskMessage {
  // Content might be the raw JSON object or already parsed
  const contentObj = typeof m.content === 'object' ? m.content as Record<string, unknown> : {}
  
  // Check if formData is already set (transformed) or needs extraction from content
  const formData: StructuredAskFormData = m.formData ?? {
    prompt: (contentObj.prompt as string) || '',
    fields: (contentObj.fields as StructuredAskFormData['fields']) || [],
    submitLabel: contentObj.submitLabel as string | undefined,
    cancelLabel: contentObj.cancelLabel as string | undefined,
  }
  
  // Check state from DB column first, then formState in content
  const formState = m.state === 'pending' ? 'pending' 
    : m.state === 'completed' ? 'submitted'
    : m.state === 'dismissed' ? 'dismissed'
    : m.formState ?? (contentObj.formState as StructuredAskMessage['formState']) ?? 'pending'
  
  return {
    ...m,
    type: 'structured_ask' as const,
    formData,
    formState,
    response: m.response ?? (contentObj.response as Record<string, unknown> | undefined),
    respondedBy: m.respondedBy ?? (contentObj.respondedBy as string | undefined),
    respondedAt: m.respondedAt ?? (contentObj.respondedAt as string | undefined),
    dismissedBy: m.dismissedBy ?? (contentObj.dismissedBy as string | undefined),
    dismissedAt: m.dismissedAt ?? (contentObj.dismissedAt as string | undefined),
  } as StructuredAskMessage
}

/**
 * Shows count of pending structured asks and provides popup to view/answer them.
 * Positioned at the right side of the roster row.
 * 
 * Fetches all pending asks from the database on mount, then updates reactively
 * when messages change (for real-time updates via WebSocket).
 */
export function PendingAsksIndicator({
  channelId,
  messages,
  spaceId,
  roster = [],
  onSubmit,
  onCancel,
}: PendingAsksIndicatorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedAskId, setSelectedAskId] = useState<string | null>(null)
  const [dbAsks, setDbAsks] = useState<StructuredAskMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const popupRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Fetch pending asks from database on mount and when channel changes
  const fetchPendingAsks = useCallback(async () => {
    if (!channelId) return
    
    try {
      setIsLoading(true)
      const result = await getPendingAsks(channelId)
      const transformed = result.messages
        .filter((m) => m.type === 'structured_ask')
        .map(transformToStructuredAsk)
        .filter((m) => m.formState === 'pending')
      setDbAsks(transformed)
    } catch (error) {
      console.error('[PendingAsksIndicator] Failed to fetch pending asks:', error)
    } finally {
      setIsLoading(false)
    }
  }, [channelId])

  useEffect(() => {
    fetchPendingAsks()
  }, [fetchPendingAsks])

  // Merge database asks with real-time message updates
  // Real-time messages take precedence (they have the latest state)
  const pendingAsks: StructuredAskMessage[] = (() => {
    // Create a map of all asks by ID, starting with DB asks
    const asksMap = new Map<string, StructuredAskMessage>()
    
    // Add DB asks first
    for (const ask of dbAsks) {
      asksMap.set(ask.id, ask)
    }
    
    // Override with real-time message updates (they have fresher state)
    for (const m of messages) {
      if (m.type === 'structured_ask') {
        const transformed = transformToStructuredAsk(m)
        asksMap.set(m.id, transformed)
      }
    }
    
    // Filter to only pending asks and return as array
    return Array.from(asksMap.values()).filter((m) => m.formState === 'pending')
  })()

  const selectedAsk = selectedAskId 
    ? pendingAsks.find(a => a.id === selectedAskId) 
    : null

  // Close popup when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popupRef.current && 
        !popupRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
        setSelectedAskId(null)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Handle Escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (selectedAskId) {
          // If viewing a form, go back to list
          setSelectedAskId(null)
        } else {
          // If viewing list, close popup
          setIsOpen(false)
        }
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, selectedAskId])

  // Handle form submission - close popup after submit
  const handleSubmit = (messageId: string, response: Record<string, unknown>) => {
    onSubmit?.(messageId, response)
    // Optimistically remove from dbAsks
    setDbAsks(prev => prev.filter(a => a.id !== messageId))
    setSelectedAskId(null)
    setIsOpen(false)
  }

  // Handle form cancellation - close popup and optimistically remove
  const handleCancel = (messageId: string) => {
    onCancel?.(messageId)
    // Optimistically remove from dbAsks so it doesn't reappear
    setDbAsks(prev => prev.filter(a => a.id !== messageId))
    setSelectedAskId(null)
    setIsOpen(false)
  }

  // Don't render anything if no pending asks (and not loading)
  if (!isLoading && pendingAsks.length === 0) {
    return null
  }

  return (
    <div className="relative">
      {/* Indicator button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'text-xs font-medium px-2 py-0.5 rounded',
          'hover:bg-secondary/50 transition-colors',
          isLoading && 'opacity-50'
        )}
        style={{ color: '#ff6600' }}
        disabled={isLoading}
      >
        {isLoading ? '...' : `${pendingAsks.length} ask${pendingAsks.length !== 1 ? 's' : ''}`}
      </button>

      {/* Popup */}
      {isOpen && (
        <div
          ref={popupRef}
          className={cn(
            'absolute z-50',
            // Position: above and to the left of the button
            'bottom-full right-0 mb-2',
            // Styling to match AgentSummonPicker
            'bg-card border border-border rounded-lg shadow-lg',
            // Size: list view is narrower, form view needs room for max-w-md form
            selectedAsk ? 'w-[480px]' : 'min-w-[280px] max-w-[320px]'
          )}
        >
          {selectedAsk ? (
            // Detail view - the form IS the popup (with its yellow border)
            <StructuredAskForm
              message={selectedAsk}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              spaceId={spaceId}
              roster={roster}
              popupMode
              onClose={() => {
                setSelectedAskId(null)
                setIsOpen(false)
              }}
            />
          ) : (
            // List view
            <div>
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-sm font-medium">
                  Pending Asks
                </span>
                <button
                  onClick={() => setIsOpen(false)}
                  className="text-muted-foreground hover:text-foreground p-1"
                >
                  ✕
                </button>
              </div>
              <div className="py-1">
                {pendingAsks.map((ask) => (
                  <button
                    key={ask.id}
                    onClick={() => setSelectedAskId(ask.id)}
                    className={cn(
                      'w-full px-3 py-2 text-left',
                      'hover:bg-secondary/50 transition-colors'
                    )}
                  >
                    <div className="text-sm font-medium truncate">
                      {ask.formData.prompt}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      from @{ask.sender}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
