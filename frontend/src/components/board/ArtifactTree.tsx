import { useMemo } from 'react'
import { TreeItem } from './TreeItem'
import type { ArtifactTreeNode } from '../../types/artifact'

interface ArtifactTreeProps {
  nodes: ArtifactTreeNode[]
  expanded: Set<string>
  selectedSlug: string | null
  onToggle: (slug: string) => void
  onSelect: (slug: string) => void
}

/**
 * Sort tree nodes: folders first, then by orderKey
 * This matches PowPow's sorting behavior
 */
function sortNodes(nodes: ArtifactTreeNode[]): ArtifactTreeNode[] {
  // Guard against non-array input (e.g., if API returns object instead of array)
  if (!Array.isArray(nodes)) return []

  // Filter out any invalid nodes (missing slug)
  const validNodes = nodes.filter(n => n && n.slug)

  return [...validNodes].sort((a, b) => {
    const aHasChildren = a.children && a.children.length > 0
    const bHasChildren = b.children && b.children.length > 0

    // Folders (nodes with children) come first
    if (aHasChildren && !bHasChildren) return -1
    if (!aHasChildren && bHasChildren) return 1

    // Then sort by orderKey (if available) or slug
    const aKey = (a as ArtifactTreeNode & { orderKey?: string }).orderKey || a.slug || ''
    const bKey = (b as ArtifactTreeNode & { orderKey?: string }).orderKey || b.slug || ''
    return aKey.localeCompare(bKey)
  })
}

export function ArtifactTree({
  nodes,
  expanded,
  selectedSlug,
  onToggle,
  onSelect,
}: ArtifactTreeProps) {
  // Sort top-level nodes
  const sortedNodes = useMemo(() => sortNodes(nodes), [nodes])

  return (
    <div className="py-1">
      {sortedNodes.map(node => (
        <TreeNode
          key={node.slug}
          node={node}
          depth={0}
          expanded={expanded}
          selectedSlug={selectedSlug}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
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
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedSlug,
  onToggle,
  onSelect,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.slug)
  const hasChildren = node.children && node.children.length > 0

  // Sort children nodes (folders first, then by orderKey)
  const sortedChildren = useMemo(
    () => hasChildren ? sortNodes(node.children!) : [],
    [node.children, hasChildren]
  )

  return (
    <>
      <TreeItem
        slug={node.slug}
        title={node.title}
        type={node.type}
        status={node.status}
        assignees={node.assignees}
        depth={depth}
        hasChildren={hasChildren ?? false}
        isExpanded={isExpanded}
        isSelected={selectedSlug === node.slug}
        onToggle={() => onToggle(node.slug)}
        onSelect={() => onSelect(node.slug)}
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
            />
          ))}
        </>
      )}
    </>
  )
}
