import React, { useState, useRef } from 'react'
import { cn } from '@/lib/utils'

interface Option {
  value: string
  label: string
}

interface EditableSelectProps {
  value: string
  onChange: (value: string) => void
  options: Option[]
  label?: string
  placeholder?: string
  className?: string
}

export function EditableSelect({
  value,
  onChange,
  options,
  label,
  placeholder = 'Click to select...',
  className,
}: EditableSelectProps) {
  const [isEditing, setIsEditing] = useState(false)
  const selectRef = useRef<HTMLSelectElement>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayValue = selectedOption?.label || placeholder

  const startEdit = () => {
    setIsEditing(true)
    // Focus select after render
    setTimeout(() => selectRef.current?.focus(), 0)
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value)
    setIsEditing(false)
  }

  const handleBlur = () => {
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setIsEditing(false)
    }
  }

  return (
    <div className={cn('space-y-1', className)}>
      {label && (
        <label className="text-xs font-medium text-muted-foreground uppercase">
          {label}
        </label>
      )}
      {isEditing ? (
        <select
          ref={selectRef}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <div
          onClick={startEdit}
          className={cn(
            'rounded-md border bg-secondary/30 px-3 py-2 cursor-pointer hover:bg-secondary/50 hover:border-primary/50 transition-colors text-sm',
            !selectedOption && 'text-muted-foreground italic'
          )}
        >
          {displayValue}
        </div>
      )}
    </div>
  )
}
