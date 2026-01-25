import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface KeyValuePair {
  key: string
  value: string
}

interface KeyValueEditorProps {
  label: string
  entries: KeyValuePair[]
  onChange: (entries: KeyValuePair[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  className?: string
}

// Check if value contains ${VAR} reference pattern
function hasEnvReference(value: string): boolean {
  return /\$\{[^}]+\}/.test(value)
}

export function KeyValueEditor({
  label,
  entries,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  className,
}: KeyValueEditorProps) {
  // Local state for editing - synced from props, flushed on blur
  const [localEntries, setLocalEntries] = useState<KeyValuePair[]>(entries)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editKey, setEditKey] = useState('')
  const [editValue, setEditValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const valueInputRef = useRef<HTMLInputElement>(null)

  // Sync local state when props change (from external updates)
  useEffect(() => {
    setLocalEntries(entries)
  }, [entries])

  // Focus key input when starting to edit
  useEffect(() => {
    if (editingIndex !== null && keyInputRef.current) {
      keyInputRef.current.focus()
    }
  }, [editingIndex])

  // Flush valid entries to parent - only non-empty key rows
  const flushChanges = useCallback(() => {
    const validEntries = localEntries.filter(e => e.key.trim() !== '')
    // Only call onChange if actually different
    if (JSON.stringify(validEntries) !== JSON.stringify(entries)) {
      onChange(validEntries)
    }
  }, [localEntries, entries, onChange])

  // Handle blur on the entire container
  const handleContainerBlur = (e: React.FocusEvent) => {
    // Check if focus is leaving the container entirely
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      // Commit current edit first
      if (editingIndex !== null) {
        commitCurrentEdit()
      }
      // Then flush all valid entries
      setTimeout(() => flushChanges(), 0)
    }
  }

  const commitCurrentEdit = () => {
    if (editingIndex === null) return

    const newEntries = [...localEntries]
    newEntries[editingIndex] = { key: editKey, value: editValue }
    setLocalEntries(newEntries)
    setEditingIndex(null)
    setEditKey('')
    setEditValue('')
  }

  const handleStartEdit = (index: number) => {
    // Commit any pending edit first
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    setEditingIndex(index)
    setEditKey(localEntries[index].key)
    setEditValue(localEntries[index].value)
  }

  const handleSaveEdit = () => {
    commitCurrentEdit()
  }

  const handleCancelEdit = () => {
    // If this was a new empty row, remove it
    if (editingIndex !== null && localEntries[editingIndex].key === '' && editKey === '') {
      setLocalEntries(localEntries.filter((_, i) => i !== editingIndex))
    }
    setEditingIndex(null)
    setEditKey('')
    setEditValue('')
  }

  const handleDelete = (index: number) => {
    const newEntries = localEntries.filter((_, i) => i !== index)
    setLocalEntries(newEntries)
    // Immediately flush deletions
    const validEntries = newEntries.filter(e => e.key.trim() !== '')
    onChange(validEntries)
  }

  const handleAddNew = () => {
    // Commit current edit first
    if (editingIndex !== null) {
      commitCurrentEdit()
    }
    const newEntries = [...localEntries, { key: '', value: '' }]
    setLocalEntries(newEntries)
    // Start editing the new row
    setEditingIndex(newEntries.length - 1)
    setEditKey('')
    setEditValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent, field: 'key' | 'value') => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
    if (e.key === 'Tab' && !e.shiftKey && field === 'key') {
      e.preventDefault()
      valueInputRef.current?.focus()
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
        {localEntries.length === 0 ? (
          <div className="px-3 py-2 text-base text-muted-foreground italic">
            No {label.toLowerCase()} configured
          </div>
        ) : (
          <div className="divide-y divide-border">
            {localEntries.map((entry, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-2 py-1.5 group"
              >
                {editingIndex === index ? (
                  // Editing mode
                  <>
                    <input
                      ref={keyInputRef}
                      type="text"
                      value={editKey}
                      onChange={(e) => setEditKey(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, 'key')}
                      placeholder={keyPlaceholder}
                      className={inputClasses}
                    />
                    <input
                      ref={valueInputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, 'value')}
                      placeholder={valuePlaceholder}
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
                      {entry.key || <span className="text-muted-foreground italic">{keyPlaceholder}</span>}
                    </div>
                    <div
                      className={cn(
                        "flex-1 px-2 py-1 text-base font-mono cursor-pointer hover:bg-secondary/50 rounded truncate",
                        hasEnvReference(entry.value) && "bg-blue-500/10 text-blue-300"
                      )}
                      onClick={() => handleStartEdit(index)}
                      title={hasEnvReference(entry.value) ? 'References environment variable' : undefined}
                    >
                      {entry.value || <span className="text-muted-foreground italic">{valuePlaceholder}</span>}
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
