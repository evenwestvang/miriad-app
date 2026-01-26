import { useState, useRef, useEffect } from 'react'
import { Plus, X, FileText, CheckSquare, Code, ChevronDown, Server, Bot, KeyRound, Search, Folder, Upload } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ArtifactType } from '../../types/artifact'

// Content-heavy artifact types (user-facing)
const CONTENT_TYPES: { value: ArtifactType; label: string; icon: typeof FileText }[] = [
  { value: 'doc', label: 'Doc', icon: FileText },
  { value: 'task', label: 'Task', icon: CheckSquare },
  { value: 'code', label: 'Code', icon: Code },
  { value: 'folder', label: 'Folder', icon: Folder },
]

// System types (configuration artifacts)
const SYSTEM_TYPES: { value: ArtifactType; label: string; icon: typeof FileText }[] = [
  { value: 'system.agent', label: 'Agent', icon: Bot },
  { value: 'system.mcp', label: 'MCP Server', icon: Server },
  { value: 'system.environment', label: 'Environment', icon: KeyRound },
]

interface BoardHeaderProps {
  onCreateClick: (type: ArtifactType) => void
  onClose: () => void
  canCreate?: boolean
  /** Whether the filter bar is visible */
  filterVisible?: boolean
  /** Callback to toggle filter visibility */
  onFilterToggle?: () => void
  /** Whether there's an active filter (to highlight the filter icon) */
  hasActiveFilter?: boolean
  /** Callback when upload is clicked */
  onUploadClick?: () => void
}

export function BoardHeader({
  onCreateClick,
  onClose,
  canCreate = true,
  filterVisible,
  onFilterToggle,
  hasActiveFilter,
  onUploadClick,
}: BoardHeaderProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  // Close dropdown on ESC
  useEffect(() => {
    if (!dropdownOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDropdownOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dropdownOpen])

  const handleTypeSelect = (type: ArtifactType) => {
    setDropdownOpen(false)
    onCreateClick(type)
  }

  return (
    <div className="flex items-center justify-between h-10 px-3 border-b border-border">
      <span className="font-medium text-base text-foreground">Board</span>
      <div className="flex items-center gap-1">
        {/* Create dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            className={cn(
              "flex items-center gap-0.5 p-1.5 rounded transition-colors",
              canCreate
                ? "hover:bg-secondary/50"
                : "opacity-50 cursor-not-allowed"
            )}
            onClick={canCreate ? () => setDropdownOpen(!dropdownOpen) : undefined}
            disabled={!canCreate}
            title={canCreate ? "Create artifact" : "Select a channel first"}
          >
            <Plus className="w-4 h-4 text-muted-foreground" />
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-md shadow-lg z-50 py-1">
              {/* Content-heavy types */}
              {CONTENT_TYPES.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.value}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-base text-foreground hover:bg-secondary/50 transition-colors"
                    onClick={() => handleTypeSelect(t.value)}
                  >
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    {t.label}
                  </button>
                )
              })}
              {/* Divider between content and system types */}
              <div className="border-t border-border my-1" />
              {/* System types */}
              {SYSTEM_TYPES.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.value}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-base text-foreground hover:bg-secondary/50 transition-colors"
                    onClick={() => handleTypeSelect(t.value)}
                  >
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    {t.label}
                  </button>
                )
              })}
              {/* Upload file */}
              {onUploadClick && (
                <>
                  <div className="border-t border-border my-1" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-base text-foreground hover:bg-secondary/50 transition-colors"
                    onClick={() => {
                      setDropdownOpen(false)
                      onUploadClick()
                    }}
                  >
                    <Upload className="w-4 h-4 text-muted-foreground" />
                    Upload file
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Filter toggle button */}
        {onFilterToggle && (
          <button
            className={cn(
              "p-1.5 rounded transition-colors",
              hasActiveFilter
                ? "text-primary"
                : "text-muted-foreground hover:bg-secondary/50"
            )}
            onClick={onFilterToggle}
            title={filterVisible ? "Hide filter (Esc)" : "Filter artifacts (/ or ⌘K)"}
          >
            <Search className="w-4 h-4" />
          </button>
        )}
        <button
          className="p-1.5 rounded hover:bg-secondary/50 transition-colors"
          onClick={onClose}
          title="Close board"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}
