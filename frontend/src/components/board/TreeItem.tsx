import { ChevronRight, FileText, CheckSquare, GitBranch, Code, Server, Bot, Target, BookOpen, Library, SquarePlay } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ArtifactType, ArtifactStatus } from '../../types/artifact'

interface TreeItemProps {
  slug: string
  title?: string
  type: ArtifactType
  status: ArtifactStatus
  assignees: string[]
  depth: number
  hasChildren: boolean
  isExpanded: boolean
  isSelected: boolean
  onToggle: () => void
  onSelect: () => void
}

// Type icons
const TYPE_ICONS: Record<ArtifactType, typeof FileText> = {
  doc: FileText,
  task: CheckSquare,
  decision: GitBranch,
  code: Code,
  knowledgebase: Library,
  asset: FileText, // Binary assets use generic file icon
  'system.mcp': Server,
  'system.agent': Bot,
  'system.focus': Target,
  'system.playbook': BookOpen,
}

/**
 * Check if an artifact slug represents an interactive app
 */
function isSpaArtifact(slug: string | undefined): boolean {
  return slug?.endsWith('.app.js') ?? false
}

/**
 * Get the appropriate icon for an artifact based on type and slug
 */
function getArtifactIcon(type: ArtifactType, slug: string): typeof FileText {
  // Interactive apps get special icon
  if (type === 'code' && isSpaArtifact(slug)) {
    return SquarePlay
  }
  return TYPE_ICONS[type] || FileText
}

// Status indicators for tasks - matches PowPow colors
const STATUS_INDICATORS: Record<string, { icon: string; className: string }> = {
  draft: { icon: '○', className: 'text-yellow-500' },
  published: { icon: '●', className: 'text-green-500' },
  archived: { icon: '◌', className: 'text-muted-foreground' },
  pending: { icon: '○', className: 'text-yellow-500' },
  in_progress: { icon: '◉', className: 'text-blue-500' },
  done: { icon: '✓', className: 'text-green-500' },
  blocked: { icon: '⊘', className: 'text-red-500' },
}

export function TreeItem({
  slug,
  title,
  type,
  status,
  // assignees - reserved for future use
  depth,
  hasChildren,
  isExpanded,
  isSelected,
  onToggle,
  onSelect,
}: TreeItemProps) {
  const Icon = getArtifactIcon(type, slug)
  // Show status indicator for tasks, and for other types when not 'published'
  const showStatus = type === 'task' || (status && status !== 'published')
  const statusIndicator = showStatus ? STATUS_INDICATORS[status] : null

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 py-1.5 cursor-pointer",
        "hover:bg-[var(--cast-bg-hover)] transition-colors",
        isSelected && "bg-[var(--cast-bg-active)]"
      )}
      style={{ paddingLeft: `${16 + depth * 12}px`, paddingRight: '16px' }}
      onClick={onSelect}
    >
      {/* Expand/collapse chevron */}
      <button
        className={cn(
          "w-4 h-4 flex items-center justify-center flex-shrink-0",
          !hasChildren && "invisible"
        )}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-[#ccc] transition-transform",
            isExpanded && "rotate-90"
          )}
        />
      </button>

      {/* Type icon */}
      <Icon className="w-4 h-4 text-[var(--cast-text-subtle)] flex-shrink-0" />

      {/* Name */}
      <span className="text-[13px] truncate flex-1 text-[var(--cast-text-secondary)]">
        {title || slug}
      </span>

      {/* Status indicator for tasks */}
      {statusIndicator && (
        <span className={cn("text-xs flex-shrink-0", statusIndicator.className)}>
          {statusIndicator.icon}
        </span>
      )}
    </div>
  )
}
