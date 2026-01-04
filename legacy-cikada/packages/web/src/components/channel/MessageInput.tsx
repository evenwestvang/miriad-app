import { useState, useCallback, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Paperclip, AtSign } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MentionAutocomplete, useMentionAutocomplete, type RosterAgent } from './MentionAutocomplete'

interface MessageInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  placeholder?: string
  roster?: RosterAgent[]
}

// Mock roster for development - will be replaced with real data from channel
const MOCK_ROSTER: RosterAgent[] = [
  { callsign: 'fox', status: 'idle' },
  { callsign: 'bear', status: 'thinking' },
  { callsign: 'owl', status: 'idle' },
  { callsign: 'wolf', status: 'offline' },
]

export function MessageInput({
  onSend,
  disabled,
  placeholder = 'Type a message...',
  roster = MOCK_ROSTER,
}: MessageInputProps) {
  const [content, setContent] = useState('')
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentionStart, setMentionStart] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { findMentionTrigger, getOptionsCount, getOptionAtIndex } = useMentionAutocomplete(roster)

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim()
    if (!trimmed) return

    onSend(trimmed)
    setContent('')
    setShowAutocomplete(false)
  }, [content, onSend])

  // Insert mention at the trigger position
  const insertMention = useCallback((mention: string) => {
    const before = content.slice(0, mentionStart)
    const after = content.slice(textareaRef.current?.selectionStart ?? content.length)
    const newContent = `${before}@${mention} ${after}`
    setContent(newContent)
    setShowAutocomplete(false)

    // Focus and set cursor position after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = mentionStart + mention.length + 2 // +2 for @ and space
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
      }
    })
  }, [content, mentionStart])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle autocomplete navigation
      if (showAutocomplete) {
        const optionsCount = getOptionsCount(autocompleteQuery)

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % optionsCount)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + optionsCount) % optionsCount)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = getOptionAtIndex(autocompleteQuery, selectedIndex)
          if (selected) {
            insertMention(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowAutocomplete(false)
          return
        }
      }

      // Submit on Enter (without Shift) when autocomplete is not showing
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [showAutocomplete, autocompleteQuery, selectedIndex, getOptionsCount, getOptionAtIndex, insertMention, handleSubmit]
  )

  // Handle input changes and detect mention triggers
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value
      const cursorPos = e.target.selectionStart

      setContent(newContent)

      // Check for mention trigger
      const trigger = findMentionTrigger(newContent, cursorPos)
      if (trigger) {
        setShowAutocomplete(true)
        setAutocompleteQuery(trigger.query)
        setMentionStart(trigger.start)
        setSelectedIndex(0)
      } else {
        setShowAutocomplete(false)
      }
    },
    [findMentionTrigger]
  )

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [content])

  // Calculate autocomplete position (above the textarea)
  const getAutocompletePosition = () => {
    return { top: 8, left: 16 }
  }

  return (
    <div className="px-4 pt-0 pb-4 bg-card">
      <div className="relative">
        {showAutocomplete && (
          <MentionAutocomplete
            query={autocompleteQuery}
            roster={roster}
            selectedIndex={selectedIndex}
            onSelect={insertMention}
            onClose={() => setShowAutocomplete(false)}
            position={getAutocompletePosition()}
          />
        )}
        {/* Input box container */}
        <div className="border border-[var(--cast-border-default)] focus-within:border-[#1a1a1a] transition-colors">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "w-full min-h-[44px] max-h-[200px] resize-none p-3",
              "bg-transparent border-none",
              "text-sm text-foreground placeholder:text-[#a0a0a0]",
              "focus:outline-none focus:ring-0",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />
          {/* Input actions row */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-[#f0f0f0]">
            {/* Left side buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Attach file"
              >
                <Paperclip className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Mention"
              >
                <AtSign className="w-[18px] h-[18px]" />
              </button>
            </div>
            {/* Send button */}
            <button
              onClick={handleSubmit}
              disabled={disabled || !content.trim()}
              className={cn(
                "p-1 transition-colors",
                content.trim() && !disabled
                  ? "text-[#8c8c8c] hover:text-[#1a1a1a]"
                  : "text-[#c0c0c0] cursor-not-allowed"
              )}
              title="Send message"
            >
              <Send className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
