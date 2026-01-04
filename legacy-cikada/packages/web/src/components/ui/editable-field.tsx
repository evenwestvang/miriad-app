import { useState, useRef, useEffect } from 'react'
import { cn } from '../../lib/utils'

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
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [editValue, multiline])

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing) {
      if (multiline && textareaRef.current) {
        textareaRef.current.focus()
      } else if (!multiline && inputRef.current) {
        inputRef.current.focus()
      }
    }
  }, [isEditing, multiline])

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

  const inputClasses = cn(
    'w-full px-2 py-1.5 text-sm bg-secondary rounded border border-border',
    'focus:outline-none focus:ring-1 focus:ring-primary',
    multiline && 'font-mono resize-none overflow-hidden',
    minHeight,
    inputClassName
  )

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          {label}
        </label>
      )}
      {isEditing ? (
        <div className="space-y-2">
          {multiline ? (
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={placeholder}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (!cancelingRef.current) saveEdit()
                }, 100)
              }}
              className={inputClasses}
            />
          ) : (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={placeholder}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (!cancelingRef.current) saveEdit()
                }, 100)
              }}
              className={inputClasses}
            />
          )}
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
              onClick={saveEdit}
            >
              Save
            </button>
            <button
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onMouseDown={() => { cancelingRef.current = true }}
              onClick={cancelEdit}
            >
              Cancel
            </button>
            <span className="text-xs text-muted-foreground ml-2">
              {multiline ? 'Cmd+Enter to save · ' : ''}Esc to cancel
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
              <pre className="text-sm whitespace-pre-wrap font-mono">{value}</pre>
            ) : (
              <span className="text-sm">{value}</span>
            )
          ) : (
            <span className="text-muted-foreground text-sm italic">{placeholder}</span>
          )}
        </div>
      )}
    </div>
  )
}
