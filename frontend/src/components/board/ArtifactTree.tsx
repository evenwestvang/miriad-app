import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { TreeItem, type DropZone } from './TreeItem'
import type { ArtifactTreeNode } from '../../types/artifact'

interface ArtifactTreeProps {
  nodes: ArtifactTreeNode[]
  expanded: Set<string>
  selectedSlug: string | null
  onToggle: (slug: string) => void
  onSelect: (slug: string) => void
  /** Optional callback when Enter is pressed on selected item (opens detail view) */
  onActivate?: (slug: string) => void
  /** Filter text to search by (matches slug and title) */
  filterText?: string
  /** Callback when an artifact is moved via drag-drop */
  onMove?: (slug: string, newParentSlug: string | null, position: 'before' | 'after' | 'into', targetSlug?: string) => void
}

/**
 * Sort tree nodes by orderKey only.
 * orderKey is the single source of truth for sibling ordering.
 */
function sortNodes(nodes: ArtifactTreeNode[]): ArtifactTreeNode[] {
  // Guard against non-array input (e.g., if API returns object instead of array)
  if (!Array.isArray(nodes)) return []

  // Filter out any invalid nodes (missing slug)
  const validNodes = nodes.filter(n => n && n.slug)

  return [...validNodes].sort((a, b) => {
    // Sort by orderKey only - it's the single source of truth
    // Use simple string comparison (not localeCompare) because fractional-indexing
    // generates keys designed for ASCII/Unicode code point ordering
    const aKey = a.orderKey || a.slug || ''
    const bKey = b.orderKey || b.slug || ''
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
}

/**
 * Build a flat list of visible nodes for keyboard navigation.
 * Only includes nodes that are currently visible (parents expanded).
 */
interface FlatNode {
  slug: string
  hasChildren: boolean
  parentSlug: string | null
}

function buildVisibleNodeList(
  nodes: ArtifactTreeNode[],
  expanded: Set<string>,
  parentSlug: string | null = null
): FlatNode[] {
  const result: FlatNode[] = []
  const sortedNodes = sortNodes(nodes)

  for (const node of sortedNodes) {
    const hasChildren = node.children && node.children.length > 0
    result.push({ slug: node.slug, hasChildren: hasChildren ?? false, parentSlug })

    // If node has children and is expanded, add children recursively
    if (hasChildren && expanded.has(node.slug)) {
      result.push(...buildVisibleNodeList(node.children!, expanded, node.slug))
    }
  }

  return result
}

/**
 * Check if a node or any of its descendants match the filter.
 * Returns { matches: boolean, matchingDescendantSlugs: string[] }
 */
function nodeMatchesFilter(
  node: ArtifactTreeNode,
  filterLower: string
): { matches: boolean; ancestorSlugs: string[] } {
  const nodeMatches =
    node.slug.toLowerCase().includes(filterLower) ||
    (node.title && node.title.toLowerCase().includes(filterLower))

  // Check children recursively
  const childResults = (node.children || []).map(child =>
    nodeMatchesFilter(child, filterLower)
  )

  const anyChildMatches = childResults.some(r => r.matches)
  const childAncestors = childResults.flatMap(r => r.ancestorSlugs)

  // If any child matches, this node's slug should be in ancestors (to auto-expand)
  const ancestorSlugs = anyChildMatches
    ? [node.slug, ...childAncestors]
    : childAncestors

  return {
    matches: nodeMatches || anyChildMatches,
    ancestorSlugs,
  }
}

/**
 * Filter tree nodes by text, keeping matching nodes and their ancestors.
 * Returns filtered tree and set of slugs that should be auto-expanded.
 */
function filterTree(
  nodes: ArtifactTreeNode[],
  filterText: string
): { filtered: ArtifactTreeNode[]; autoExpand: Set<string> } {
  if (!filterText.trim()) {
    return { filtered: nodes, autoExpand: new Set() }
  }

  const filterLower = filterText.toLowerCase().trim()
  const autoExpandSlugs: string[] = []

  function filterNodes(nodeList: ArtifactTreeNode[]): ArtifactTreeNode[] {
    const result: ArtifactTreeNode[] = []

    for (const node of nodeList) {
      const { matches, ancestorSlugs } = nodeMatchesFilter(node, filterLower)

      if (matches) {
        // Add ancestor slugs for auto-expansion
        autoExpandSlugs.push(...ancestorSlugs)

        // Include this node with filtered children
        const filteredChildren = node.children
          ? filterNodes(node.children)
          : undefined

        result.push({
          ...node,
          children: filteredChildren,
        })
      }
    }

    return result
  }

  const filtered = filterNodes(nodes)
  return { filtered, autoExpand: new Set(autoExpandSlugs) }
}

/**
 * Get parent slug for a node.
 * Returns undefined if not found (to distinguish from null = root level).
 */
function getParentSlug(nodes: ArtifactTreeNode[], targetSlug: string, parentSlug: string | null = null): string | null | undefined {
  for (const node of nodes) {
    if (node.slug === targetSlug) return parentSlug
    if (node.children) {
      const found = getParentSlug(node.children, targetSlug, node.slug)
      if (found !== undefined) return found
    }
  }
  return undefined  // Not found in this subtree - continue searching siblings
}

export function ArtifactTree({
  nodes,
  expanded,
  selectedSlug,
  onToggle,
  onSelect,
  onActivate,
  filterText = '',
  onMove,
}: ArtifactTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Drag-drop state
  const [draggedSlug, setDraggedSlug] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ slug: string; zone: DropZone } | null>(null)

  // Filter and auto-expand based on filterText
  const { filtered: filteredNodes, autoExpand } = useMemo(
    () => filterTree(nodes, filterText),
    [nodes, filterText]
  )

  // Combine user-expanded + auto-expanded (from filter matches)
  const effectiveExpanded = useMemo(() => {
    if (autoExpand.size === 0) return expanded
    return new Set([...expanded, ...autoExpand])
  }, [expanded, autoExpand])

  // Sort top-level nodes
  const sortedNodes = useMemo(() => sortNodes(filteredNodes), [filteredNodes])

  // Build flat list of visible nodes for keyboard navigation
  const visibleNodes = useMemo(
    () => buildVisibleNodeList(filteredNodes, effectiveExpanded),
    [filteredNodes, effectiveExpanded]
  )

  // Find index of currently selected node in visible list
  const selectedIndex = useMemo(() => {
    if (!selectedSlug) return -1
    return visibleNodes.findIndex(n => n.slug === selectedSlug)
  }, [visibleNodes, selectedSlug])

  // Build set of invalid drop targets (self and descendants of dragged item)
  const invalidDropTargets = useMemo(() => {
    if (!draggedSlug) return new Set<string>()

    const invalid = new Set<string>([draggedSlug])

    // Add all descendants
    function addDescendants(nodeList: ArtifactTreeNode[]) {
      for (const node of nodeList) {
        if (node.slug === draggedSlug) {
          // Found the dragged node - add all its descendants
          function collectDescendants(children: ArtifactTreeNode[]) {
            for (const child of children) {
              invalid.add(child.slug)
              if (child.children) collectDescendants(child.children)
            }
          }
          if (node.children) collectDescendants(node.children)
        } else if (node.children) {
          addDescendants(node.children)
        }
      }
    }

    addDescendants(nodes)
    return invalid
  }, [draggedSlug, nodes])

  // Scroll selected item into view when selection changes
  useEffect(() => {
    if (selectedSlug && containerRef.current) {
      const selectedElement = containerRef.current.querySelector(`[data-slug="${selectedSlug}"]`)
      selectedElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedSlug])

  // Drag handlers
  const handleDragStart = useCallback((slug: string) => {
    setDraggedSlug(slug)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedSlug(null)
    setDropTarget(null)
  }, [])

  const handleDragOver = useCallback((slug: string, zone: DropZone) => {
    setDropTarget({ slug, zone })
  }, [])

  const handleDragLeave = useCallback(() => {
    setDropTarget(null)
  }, [])

  const handleDrop = useCallback((targetSlug: string, zone: DropZone) => {
    if (!draggedSlug || !zone || !onMove) {
      setDraggedSlug(null)
      setDropTarget(null)
      return
    }

    // Calculate new parent and position
    const targetParentSlug = getParentSlug(nodes, targetSlug) ?? null

    if (zone === 'on') {
      // Drop as child of target
      onMove(draggedSlug, targetSlug, 'into')
    } else if (zone === 'above') {
      // Drop before target (same parent as target)
      onMove(draggedSlug, targetParentSlug, 'before', targetSlug)
    } else if (zone === 'below') {
      // Drop after target (same parent as target)
      onMove(draggedSlug, targetParentSlug, 'after', targetSlug)
    }

    setDraggedSlug(null)
    setDropTarget(null)
  }, [draggedSlug, nodes, onMove])

  // Keyboard navigation handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (visibleNodes.length === 0) return

    const currentNode = selectedIndex >= 0 ? visibleNodes[selectedIndex] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        // Move to next visible item
        const nextIndex = selectedIndex < visibleNodes.length - 1 ? selectedIndex + 1 : 0
        onSelect(visibleNodes[nextIndex].slug)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        // Move to previous visible item
        const prevIndex = selectedIndex > 0 ? selectedIndex - 1 : visibleNodes.length - 1
        onSelect(visibleNodes[prevIndex].slug)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (!currentNode) break
        if (currentNode.hasChildren && !effectiveExpanded.has(currentNode.slug)) {
          // Expand if collapsed
          onToggle(currentNode.slug)
        } else if (currentNode.hasChildren && effectiveExpanded.has(currentNode.slug)) {
          // Move to first child if already expanded
          const firstChildIndex = selectedIndex + 1
          if (firstChildIndex < visibleNodes.length && visibleNodes[firstChildIndex].parentSlug === currentNode.slug) {
            onSelect(visibleNodes[firstChildIndex].slug)
          }
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (!currentNode) break
        if (currentNode.hasChildren && effectiveExpanded.has(currentNode.slug)) {
          // Collapse if expanded
          onToggle(currentNode.slug)
        } else if (currentNode.parentSlug) {
          // Move to parent if collapsed or leaf
          onSelect(currentNode.parentSlug)
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (currentNode && onActivate) {
          onActivate(currentNode.slug)
        }
        break
      }
      case ' ': {
        e.preventDefault()
        if (currentNode?.hasChildren) {
          onToggle(currentNode.slug)
        }
        break
      }
      case 'Home': {
        e.preventDefault()
        if (visibleNodes.length > 0) {
          onSelect(visibleNodes[0].slug)
        }
        break
      }
      case 'End': {
        e.preventDefault()
        if (visibleNodes.length > 0) {
          onSelect(visibleNodes[visibleNodes.length - 1].slug)
        }
        break
      }
    }
  }, [visibleNodes, selectedIndex, effectiveExpanded, onToggle, onSelect, onActivate])

  // Focus container on mount and when clicking in it
  const handleContainerClick = useCallback(() => {
    containerRef.current?.focus()
  }, [])

  return (
    <div
      ref={containerRef}
      className="py-1 outline-none"
      tabIndex={0}
      role="tree"
      aria-label="Artifact tree"
      onKeyDown={handleKeyDown}
      onClick={handleContainerClick}
    >
      {sortedNodes.length === 0 && filterText ? (
        <div className="px-4 py-6 text-center text-base text-muted-foreground">
          No matches for "{filterText}"
        </div>
      ) : (
        sortedNodes.map(node => (
          <TreeNode
            key={node.slug}
            node={node}
            depth={0}
            expanded={effectiveExpanded}
            selectedSlug={selectedSlug}
            onToggle={onToggle}
            onSelect={onSelect}
            // Drag-drop props
            draggedSlug={draggedSlug}
            dropTarget={dropTarget}
            invalidDropTargets={invalidDropTargets}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          />
        ))
      )}
    </div>
  )
}

interface TreeNodeProps {
  node: ArtifactTreeNode
  depth: number
  expanded: Set<string>
  selectedSlug: string | null
  onToggle: (slug: string) => void
  onSelect: (slug: string) => void
  // Drag-drop props
  draggedSlug: string | null
  dropTarget: { slug: string; zone: DropZone } | null
  invalidDropTargets: Set<string>
  onDragStart: (slug: string) => void
  onDragEnd: () => void
  onDragOver: (slug: string, zone: DropZone) => void
  onDragLeave: () => void
  onDrop: (targetSlug: string, zone: DropZone) => void
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedSlug,
  onToggle,
  onSelect,
  draggedSlug,
  dropTarget,
  invalidDropTargets,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.slug)
  const hasChildren = node.children && node.children.length > 0

  // Sort children nodes (folders first, then by orderKey)
  const sortedChildren = useMemo(
    () => hasChildren ? sortNodes(node.children!) : [],
    [node.children, hasChildren]
  )

  // Get drop zone for this node
  const dropZone = dropTarget?.slug === node.slug ? dropTarget.zone : null

  return (
    <>
      <TreeItem
        slug={node.slug}
        title={node.title}
        type={node.type}
        status={node.status}
        assignees={node.assignees}
        contentType={node.contentType}
        depth={depth}
        hasChildren={hasChildren ?? false}
        isExpanded={isExpanded}
        isSelected={selectedSlug === node.slug}
        onToggle={() => onToggle(node.slug)}
        onSelect={() => onSelect(node.slug)}
        // Drag-drop props
        draggedSlug={draggedSlug}
        dropZone={dropZone}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        isInvalidDropTarget={invalidDropTargets.has(node.slug)}
      />
      {hasChildren && isExpanded && (
        <>
          {sortedChildren.map(child => (
            <TreeNode
              key={child.slug}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedSlug={selectedSlug}
              onToggle={onToggle}
              onSelect={onSelect}
              draggedSlug={draggedSlug}
              dropTarget={dropTarget}
              invalidDropTargets={invalidDropTargets}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            />
          ))}
        </>
      )}
    </>
  )
}
