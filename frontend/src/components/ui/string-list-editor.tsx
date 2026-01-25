import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'

interface StringListEditorProps {
  label: string
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
  className?: string
}

export function StringListEditor({
  label,
  items,
  onChange,
  placeholder = 'Enter value...',
  className,
}: StringListEditorProps) {
  // Local state for editing - synced from props, flushed on blur
  const [localItems, setLocalItems] = useState<string[]>(items)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync local state when props change (from external updates)
  useEffect(() => {
    setLocalItems(items)
  }, [items])

  // Focus input when starting to edit
  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editingIndex])

  // Flush valid items to parent - only non-empty strings
  const flushChanges = useCallback(() => {
    const validItems = localItems.filter(item => item.trim() !== '')
    // Only call onChange if actually different
    if (JSON.stringify(validItems) !== JSON.stringify(items)) {
      onChange(validItems)
    }
  }, [localItems, items, onChange])

  // Handle blur on the entire container
  const handleContainerBlur = (e: React.FocusEvent) => {
    // Check if focus is leaving the container entirely
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      // Commit current edit first
      if (editingIndex !== null) {
        commitCurrentEdit()
      }
      // Then flush all valid items
      setTimeout(() => flushChanges(), 0)
    }
  }

  const commitCurrentEdit = () => {
    if (editingIndex === null) return

    const newItems = [...localItems]
    newItems[editingIndex] = editValue
    setLocalItems(newItems)
    setEditingIndex(null)
    setEditValue('')
  }

  const handleStartEdit = (index: number) => {
    // Commit any pending edit first
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    setEditingIndex(index)
    setEditValue(localItems[index])
  }

  const handleSaveEdit = () => {
    commitCurrentEdit()
  }

  const handleCancelEdit = () => {
    // If this was a new empty item, remove it
    if (editingIndex !== null && localItems[editingIndex] === '' && editValue === '') {
      setLocalItems(localItems.filter((_, i) => i !== editingIndex))
    }
    setEditingIndex(null)
    setEditValue('')
  }

  const handleDelete = (index: number) => {
    const newItems = localItems.filter((_, i) => i !== index)
    setLocalItems(newItems)
    // Immediately flush deletions
    const validItems = newItems.filter(item => item.trim() !== '')
    onChange(validItems)
  }

  const handleAddNew = () => {
    // Commit current edit first
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    const newItems = [...localItems, '']
    setLocalItems(newItems)
    // Start editing the new item
    setEditingIndex(newItems.length - 1)
    setEditValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
  }

  const inputClasses = 'flex-1 h-8 px-2 text-base font-mono bg-secondary border border-border focus:outline-none focus:ring-0 focus:border-foreground'

  return (
    <div
      ref={containerRef}
      className={cn('space-y-2', className)}
      onBlur={handleContainerBlur}
    >
      <label className="block text-xs font-medium text-muted-foreground uppercase">
        {label}
      </label>

      <div className="rounded-md border bg-secondary/30">
        {localItems.length === 0 ? (
          <div className="px-3 py-2 text-base text-muted-foreground italic">
            No {label.toLowerCase()} configured
          </div>
        ) : (
          <div className="divide-y divide-border">
            {localItems.map((item, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-2 py-1.5 group"
              >
                {editingIndex === index ? (
                  // Editing mode
                  <>
                    <input
                      ref={inputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={placeholder}
                      className={inputClasses}
                    />
                    <button
                      className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDelete(index)}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  // Display mode
                  <>
                    <div
                      className="flex-1 px-2 py-1 text-base font-mono cursor-pointer hover:bg-secondary/50 rounded truncate"
                      onClick={() => handleStartEdit(index)}
                    >
                      {item || <span className="text-muted-foreground italic">{placeholder}</span>}
                    </div>
                    <button
                      className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDelete(index)}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add button - outside the table */}
      <button
        onClick={handleAddNew}
        className="flex items-center gap-1.5 px-2 py-1.5 text-base border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Add {label.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  )
}
