import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getArtifactIcon } from '../../lib/artifact-icons'
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
  /** Binary asset encoding (e.g., 'file') */
  encoding?: string | null
  /** Binary asset content type (e.g., 'image/png') */
  contentType?: string | null
  onToggle: () => void
  onSelect: () => void
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
  encoding,
  contentType,
  onToggle,
  onSelect,
}: TreeItemProps) {
  const Icon = getArtifactIcon({ slug, type, status, encoding, contentType })
  // Show status indicator for tasks, and for other types when not 'published'
  const showStatus = type === 'task' || (status && status !== 'published')
  const statusIndicator = showStatus ? STATUS_INDICATORS[status] : null

  return (
    <div
      data-slug={slug}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isExpanded : undefined}
      className={cn(
        "flex items-center gap-1.5 py-1.5 cursor-pointer",
        "hover:bg-[var(--cast-bg-hover)] transition-colors",
        isSelected && "bg-[var(--cast-bg-active)] ring-1 ring-inset ring-primary/30"
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
