import { useRef, useCallback } from 'react'
import { ChevronRight, GripVertical } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getArtifactIcon } from '../../lib/artifact-icons'
import type { ArtifactType, ArtifactStatus } from '../../types/artifact'

export type DropZone = 'above' | 'on' | 'below' | null

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
  /** Drag-drop props */
  draggedSlug?: string | null
  dropZone?: DropZone
  onDragStart?: (slug: string) => void
  onDragEnd?: () => void
  onDragOver?: (slug: string, zone: DropZone) => void
  onDragLeave?: () => void
  onDrop?: (targetSlug: string, zone: DropZone) => void
  /** Whether this item can accept children (for 'on' drop zone) */
  canHaveChildren?: boolean
  /** Whether drop is invalid (self or descendant) */
  isInvalidDropTarget?: boolean
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

// Types that can have children (accept 'on' drops)
const PARENT_CAPABLE_TYPES: ArtifactType[] = ['doc', 'folder', 'task', 'decision']

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
  // Drag-drop props
  draggedSlug,
  dropZone,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  canHaveChildren = PARENT_CAPABLE_TYPES.includes(type),
  isInvalidDropTarget = false,
}: TreeItemProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const Icon = getArtifactIcon({ slug, type, status, encoding, contentType })

  // Show status indicator for tasks, and for other types when not 'published'
  const showStatus = type === 'task' || (status && status !== 'published')
  const statusIndicator = showStatus ? STATUS_INDICATORS[status] : null

  const isDragging = draggedSlug === slug
  const isDragActive = draggedSlug !== null

  // Calculate drop zone from cursor position
  const calculateDropZone = useCallback((e: React.DragEvent): DropZone => {
    if (!rowRef.current || isInvalidDropTarget) return null

    const rect = rowRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height
    const percent = y / height

    if (percent < 0.25) return 'above'
    if (percent > 0.75) return 'below'
    // Middle zone - only 'on' if target can have children
    return canHaveChildren ? 'on' : (percent < 0.5 ? 'above' : 'below')
  }, [canHaveChildren, isInvalidDropTarget])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', slug)
    onDragStart?.(slug)
  }, [slug, onDragStart])

  const handleDragEnd = useCallback(() => {
    onDragEnd?.()
  }, [onDragEnd])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (isDragging || isInvalidDropTarget) {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    e.dataTransfer.dropEffect = 'move'
    const zone = calculateDropZone(e)
    onDragOver?.(slug, zone)
  }, [isDragging, isInvalidDropTarget, calculateDropZone, slug, onDragOver])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only trigger if actually leaving this element (not entering a child)
    if (rowRef.current && !rowRef.current.contains(e.relatedTarget as Node)) {
      onDragLeave?.()
    }
  }, [onDragLeave])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (isDragging || isInvalidDropTarget) return
    const zone = calculateDropZone(e)
    onDrop?.(slug, zone)
  }, [isDragging, isInvalidDropTarget, calculateDropZone, slug, onDrop])

  return (
    <div
      ref={rowRef}
      data-slug={slug}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isExpanded : undefined}
      className={cn(
        "group relative flex items-center gap-1 py-1.5 cursor-pointer",
        "hover:bg-[var(--cast-bg-hover)] transition-colors",
        isSelected && "bg-[var(--cast-bg-active)] ring-1 ring-inset ring-primary/30",
        // Drag states
        isDragging && "opacity-50",
        dropZone === 'on' && "bg-primary/20 ring-1 ring-inset ring-primary",
        isInvalidDropTarget && isDragActive && "cursor-not-allowed"
      )}
      style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: '16px' }}
      onClick={onSelect}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop indicator line - above */}
      {dropZone === 'above' && (
        <div
          className="absolute left-0 right-0 top-0 h-0.5 bg-primary z-10 pointer-events-none"
          style={{ marginLeft: `${8 + depth * 12}px` }}
        />
      )}

      {/* Drop indicator line - below */}
      {dropZone === 'below' && (
        <div
          className="absolute left-0 right-0 bottom-0 h-0.5 bg-primary z-10 pointer-events-none"
          style={{ marginLeft: `${8 + depth * 12}px` }}
        />
      )}

      {/* Drag handle - visible on hover */}
      <div
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={cn(
          "w-4 h-4 flex items-center justify-center flex-shrink-0 cursor-grab",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          isDragActive && "opacity-100"
        )}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground" />
      </div>

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
