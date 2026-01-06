import { useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface TreeSearchProps {
  value: string
  onChange: (value: string) => void
  onClear: () => void
  placeholder?: string
  className?: string
}

export function TreeSearch({
  value,
  onChange,
  onClear,
  placeholder = 'Filter artifacts...',
  className,
}: TreeSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // "/" to focus search (when not in an input)
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as Element)?.tagName)) {
        e.preventDefault()
        inputRef.current?.focus()
      }
      // Cmd/Ctrl+K to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Handle Escape to clear
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (value) {
        onClear()
      } else {
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
          "w-full h-8 pl-8 pr-8 text-sm",
          "bg-[var(--cast-bg-input)] border border-[var(--cast-border-default)]",
          "placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-1 focus:ring-primary/50",
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
