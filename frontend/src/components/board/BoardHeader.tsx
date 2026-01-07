import { useState, useRef, useEffect } from 'react'
import { Plus, X, Upload, FileText, CheckSquare, GitBranch, Code, ChevronDown, Server, Bot, Target, BookOpen, Library, Plug2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ArtifactType } from '../../types/artifact'

// All artifact types with icons and labels
const ARTIFACT_TYPES: { value: ArtifactType; label: string; icon: typeof FileText }[] = [
  { value: 'doc', label: 'Document', icon: FileText },
  { value: 'task', label: 'Task', icon: CheckSquare },
  { value: 'decision', label: 'Decision', icon: GitBranch },
  { value: 'code', label: 'Code', icon: Code },
  { value: 'knowledgebase', label: 'Knowledge Base', icon: Library },
  { value: 'system.mcp', label: 'MCP Server', icon: Server },
  { value: 'system.agent', label: 'Agent', icon: Bot },
  { value: 'system.focus', label: 'Focus', icon: Target },
  { value: 'system.playbook', label: 'Playbook', icon: BookOpen },
  { value: 'system.app', label: 'App', icon: Plug2 },
]

interface BoardHeaderProps {
  onCreateClick: (type: ArtifactType) => void
  onUploadClick: () => void
  onClose: () => void
  canCreate?: boolean
}

export function BoardHeader({ onCreateClick, onUploadClick, onClose, canCreate = true }: BoardHeaderProps) {
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
      <span className="font-medium text-sm text-foreground">Board</span>
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
              {ARTIFACT_TYPES.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.value}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-secondary/50 transition-colors"
                    onClick={() => handleTypeSelect(t.value)}
                  >
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    {t.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <button
          className={cn(
            "p-1.5 rounded transition-colors",
            canCreate
              ? "hover:bg-secondary/50"
              : "opacity-50 cursor-not-allowed"
          )}
          onClick={canCreate ? onUploadClick : undefined}
          disabled={!canCreate}
          title={canCreate ? "Upload file" : "Select a channel first"}
        >
          <Upload className="w-4 h-4 text-muted-foreground" />
        </button>
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
