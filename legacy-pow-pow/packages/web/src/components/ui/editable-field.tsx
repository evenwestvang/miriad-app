import React, { useState, useRef, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Input } from './input'
import { Textarea } from './textarea'
import { Button } from './button'
import { cn } from '@/lib/utils'

interface EditableFieldProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  multiline?: boolean
  minHeight?: string
  className?: string
  inputClassName?: string
  previewClassName?: string
}

export function EditableField({
  value,
  onChange,
  label,
  placeholder = 'Click to edit...',
  multiline = false,
  minHeight = multiline ? 'min-h-[200px]' : 'min-h-[2.5rem]',
  className,
  inputClassName,
  previewClassName,
}: EditableFieldProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const cancelingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [editValue, multiline])

  const hasUnsavedChanges = isEditing && editValue !== value

  const startEdit = (e?: React.MouseEvent) => {
    if (e && (e.target as HTMLElement).closest('a')) return
    setIsEditing(true)
    setEditValue(value)
  }

  const saveEdit = () => {
    if (cancelingRef.current) {
      cancelingRef.current = false
      return
    }
    onChange(editValue)
    setIsEditing(false)
  }

  const cancelEdit = () => {
    if (hasUnsavedChanges) {
      // For now just cancel - could add confirmation dialog
      cancelingRef.current = true
    }
    setIsEditing(false)
    setEditValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      saveEdit()
    }
    // For single-line input, Enter saves
    if (!multiline && e.key === 'Enter') {
      e.preventDefault()
      saveEdit()
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <label className="text-xs font-medium text-muted-foreground uppercase">
          {label}
        </label>
      )}
      {isEditing ? (
        <div className="space-y-2">
          {multiline ? (
            <Textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={placeholder}
              autoFocus
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Small delay to allow button clicks to register
                setTimeout(() => {
                  if (!cancelingRef.current) saveEdit()
                }, 100)
              }}
              className={cn('font-mono text-sm resize-none overflow-hidden', minHeight, inputClassName)}
            />
          ) : (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={placeholder}
              autoFocus
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (!cancelingRef.current) saveEdit()
                }, 100)
              }}
              className={inputClassName}
            />
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveEdit}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onMouseDown={() => { cancelingRef.current = true }}
              onClick={cancelEdit}
            >
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground ml-2">
              {multiline ? '⌘+Enter to save · ' : ''}Esc to cancel
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={startEdit}
          className={cn(
            'rounded-md border bg-secondary/30 cursor-pointer hover:bg-secondary/50 hover:border-primary/50 transition-colors',
            multiline ? 'p-4' : 'px-3 py-2',
            minHeight,
            previewClassName
          )}
        >
          {value ? (
            multiline ? (
              <Markdown
                className="prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                remarkPlugins={[remarkGfm]}
              >
                {value}
              </Markdown>
            ) : (
              <span>{value}</span>
            )
          ) : (
            <span className="text-muted-foreground text-sm italic">{placeholder}</span>
          )}
        </div>
      )}
    </div>
  )
}
