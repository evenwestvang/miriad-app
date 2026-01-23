import { useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface TreeSearchProps {
  value: string
  onChange: (value: string) => void
  onClear: () => void
  /** Called when Escape is pressed and the input is empty */
  onEscapeEmpty?: () => void
  placeholder?: string
  className?: string
  /** Auto-focus the input on mount */
  autoFocus?: boolean
}

export function TreeSearch({
  value,
  onChange,
  onClear,
  onEscapeEmpty,
  placeholder = 'Filter artifacts...',
  className,
  autoFocus,
}: TreeSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus on mount if requested
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus()
    }
  }, [autoFocus])

  // Handle Escape to clear or close
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (value) {
        onClear()
      } else {
        onEscapeEmpty?.()
        inputRef.current?.blur()
      }
    }
  }

  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "w-full h-8 pl-8 pr-8 text-base",
          "bg-transparent",
          "placeholder:text-muted-foreground",
          "focus:outline-none",
          "transition-colors"
        )}
      />
      {value && (
        <button
          onClick={onClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-[var(--cast-bg-hover)] rounded transition-colors"
          title="Clear filter (Esc)"
        >
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
