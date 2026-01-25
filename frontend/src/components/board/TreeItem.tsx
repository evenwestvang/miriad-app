import { useRef, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getArtifactIcon } from '../../lib/artifact-icons'
import { StatusIndicator } from './StatusIndicator'
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
  canHaveChildren = true, // All items can accept children
  isInvalidDropTarget = false,
}: TreeItemProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const Icon = getArtifactIcon({ slug, type, status, contentType })

  // Show status indicator dot only for tasks (non-tasks use typography treatment)
  const showStatusIndicator = type === 'task'
  // Typography treatment for non-task statuses
  const isDraft = type !== 'task' && status === 'draft'

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
      draggable
      className={cn(
        "group relative flex items-center gap-1 py-1.5 cursor-grab",
        "hover:bg-[var(--cast-bg-hover)] transition-colors",
        isSelected && "bg-[var(--cast-bg-active)] ring-1 ring-inset ring-primary/30",
        // Drag states
        isDragging && "opacity-50 cursor-grabbing",
        dropZone === 'on' && "bg-primary/20 ring-1 ring-inset ring-primary",
        isInvalidDropTarget && isDragActive && "cursor-not-allowed"
      )}
      style={{ paddingLeft: `${12 + depth * 20}px`, paddingRight: '12px' }}
      onClick={onSelect}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop indicator line - above */}
      {dropZone === 'above' && (
        <div
          className="absolute left-0 right-0 top-0 h-0.5 bg-primary z-10 pointer-events-none"
          style={{ marginLeft: `${8 + depth * 20}px` }}
        />
      )}

      {/* Drop indicator line - below */}
      {dropZone === 'below' && (
        <div
          className="absolute left-0 right-0 bottom-0 h-0.5 bg-primary z-10 pointer-events-none"
          style={{ marginLeft: `${8 + depth * 20}px` }}
        />
      )}

      {/* Expand/collapse chevron - always reserve space */}
      <button
        className={cn(
          "w-6 h-6 -m-1 flex items-center justify-center flex-shrink-0 rounded hover:bg-secondary/50",
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

      {/* Name with status indicator (tasks) or typography treatment (non-tasks) */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className={cn(
          "text-base truncate",
          isDraft
            ? "text-muted-foreground"
            : "text-foreground"
        )}>
          {title || slug}
        </span>
        {showStatusIndicator && <StatusIndicator status={status} />}
      </span>
    </div>
  )
}
