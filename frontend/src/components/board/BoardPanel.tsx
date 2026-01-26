import { useState, useEffect, useCallback, useRef } from 'react'
import { LayoutGrid } from 'lucide-react'
import { generateKeyBetween } from 'fractional-indexing'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import { BoardHeader } from './BoardHeader'
import { ArtifactTree } from './ArtifactTree'
import { ArtifactDetail } from './ArtifactDetail'
import { AssetUpload, type Asset } from './AssetUpload'
import { FileDropZone } from './FileDropZone'
import { TreeSearch } from './TreeSearch'
import { ArchiveToast, type ArchivedItem } from './ArchiveToast'
import type { Artifact, ArtifactTreeNode, ArtifactType } from '../../types/artifact'

interface BoardPanelProps {
  channelId: string | null
  isOpen: boolean
  onClose: () => void
  apiHost: string
  /** Space ID for OAuth flows (system.app artifacts) */
  spaceId?: string
  /** Increment to trigger tree refresh (from artifact WebSocket events) */
  refreshTrigger?: number
  /** Externally controlled selected artifact slug (for URL routing) */
  selectedArtifact?: string | null
  /** Callback when an artifact is selected (for URL routing) */
  onSelectArtifact?: (slug: string) => void
  /** Callback when selection is cleared (for URL routing) */
  onClearSelection?: () => void
}

const MIN_WIDTH = 280
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 320

export function BoardPanel({
  channelId,
  isOpen,
  onClose,
  apiHost,
  spaceId,
  refreshTrigger,
  selectedArtifact: externalSelectedSlug,
  onSelectArtifact,
  onClearSelection,
}: BoardPanelProps) {
  // Panel width (resizable)
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem('board-panel-width')
    return stored ? parseInt(stored, 10) : DEFAULT_WIDTH
  })

  // Tree data
  const [tree, setTree] = useState<ArtifactTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Selection state (editing is now handled in-place by ArtifactDetail)
  // Use external selection if provided (URL routing), otherwise use internal state
  const [internalSelectedSlug, setInternalSelectedSlug] = useState<string | null>(null)
  const selectedSlug = externalSelectedSlug !== undefined ? externalSelectedSlug : internalSelectedSlug
  const [selectedArtifactData, setSelectedArtifactData] = useState<Artifact | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [createType, setCreateType] = useState<ArtifactType>('doc')
  const [isUploading, setIsUploading] = useState(false)

  // Filter state (with debouncing)
  const [filterInput, setFilterInput] = useState('')
  const [filterText, setFilterText] = useState('')
  const [filterVisible, setFilterVisible] = useState(false)

  // Archive toast state
  const [archivedItems, setArchivedItems] = useState<ArchivedItem[]>([])

  // Debounce filter input
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilterText(filterInput)
    }, 150)
    return () => clearTimeout(timer)
  }, [filterInput])

  // Clear filter when channel changes
  useEffect(() => {
    setFilterInput('')
    setFilterText('')
    setFilterVisible(false)
  }, [channelId])

  // Keyboard shortcuts for filter visibility
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs (unless Escape)
      const isInput = ['INPUT', 'TEXTAREA'].includes((e.target as Element)?.tagName)

      // "/" to show filter (when not in an input)
      if (e.key === '/' && !isInput) {
        e.preventDefault()
        setFilterVisible(true)
      }
      // Cmd/Ctrl+K to show filter
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setFilterVisible(true)
      }
      // Escape to hide filter (if visible and empty)
      if (e.key === 'Escape' && filterVisible && !filterInput) {
        e.preventDefault()
        setFilterVisible(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, filterVisible, filterInput])

  // Unified selection handler
  const setSelectedSlug = useCallback((slug: string | null) => {
    if (onSelectArtifact && slug) {
      onSelectArtifact(slug)
    } else if (onClearSelection && !slug) {
      onClearSelection()
    } else {
      setInternalSelectedSlug(slug)
    }
  }, [onSelectArtifact, onClearSelection])

  // Resize handling
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(width)

  // Persist width to localStorage
  useEffect(() => {
    localStorage.setItem('board-panel-width', String(width))
  }, [width])

  // Fetch tree when channel changes
  useEffect(() => {
    console.log('[BoardPanel] useEffect triggered:', { channelId, isOpen, apiHost, refreshTrigger })
    if (!channelId || !isOpen) {
      console.log('[BoardPanel] Bailing early - channelId:', channelId, 'isOpen:', isOpen)
      setTree([])
      setInternalSelectedSlug(null)
      setSelectedArtifactData(null)
      return
    }

    async function fetchTree() {
      console.log('[BoardPanel] fetchTree called for channel:', channelId)
      setTreeLoading(true)
      try {
        const url = `${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`
        console.log('[BoardPanel] Fetching:', url)
        const response = await apiFetch(url)
        console.log('[BoardPanel] Response status:', response.status)
        if (!response.ok) throw new Error('Failed to fetch tree')
        const data = await response.json()
        console.log('[BoardPanel] Tree data:', data)
        setTree(data.tree || [])
      } catch (error) {
        console.error('Failed to fetch artifact tree:', error)
        setTree([])
      } finally {
        setTreeLoading(false)
      }
    }

    fetchTree()
  }, [channelId, isOpen, apiHost, refreshTrigger])

  // Fetch selected artifact details
  useEffect(() => {
    if (!channelId || !selectedSlug) {
      setSelectedArtifactData(null)
      return
    }

    async function fetchArtifact() {
      try {
        const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${selectedSlug}`)
        if (!response.ok) throw new Error('Failed to fetch artifact')
        const data = await response.json()
        setSelectedArtifactData(data)
      } catch (error) {
        console.error('Failed to fetch artifact:', error)
        setSelectedArtifactData(null)
      }
    }

    fetchArtifact()
  }, [channelId, selectedSlug, apiHost])

  // Handle resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Toggle expand/collapse
  const toggleExpanded = useCallback((slug: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(slug)) {
        next.delete(slug)
      } else {
        next.add(slug)
      }
      return next
    })
  }, [])

  // Select artifact (also dismisses archive toast)
  const handleSelect = useCallback((slug: string) => {
    setSelectedSlug(slug)
    setArchivedItems([]) // Clear archive toast on selection
  }, [setSelectedSlug])

  // Clear filter
  const handleClearFilter = useCallback(() => {
    setFilterInput('')
    setFilterText('')
  }, [])

  // Toggle filter visibility
  const handleFilterToggle = useCallback(() => {
    setFilterVisible(prev => !prev)
  }, [])

  // Dismiss archive toast (called on user actions like select, create, close)
  const dismissArchiveToast = useCallback(() => {
    setArchivedItems([])
  }, [])

  // Archive current artifact (recursive)
  const handleArchive = useCallback(async () => {
    if (!channelId || !selectedSlug) return

    try {
      const response = await apiFetch(
        `${apiHost}/channels/${channelId}/artifacts/${selectedSlug}?recursive=true&sender=user`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('Failed to archive:', data.error || 'Unknown error')
        return
      }

      const data = await response.json()
      // data.items contains { slug, previousStatus } for each archived item
      setArchivedItems(data.items || [{ slug: selectedSlug, previousStatus: 'active' }])

      // Clear selection and go back to tree
      setSelectedArtifactData(null)
      if (onClearSelection) {
        onClearSelection()
      }

      // Refresh tree
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(treeData => setTree(treeData.tree || []))
        .catch(console.error)
    } catch (err) {
      console.error('Archive error:', err)
    }
  }, [channelId, selectedSlug, apiHost, onClearSelection])

  // Undo archive (restore previous statuses)
  const handleUndoArchive = useCallback(async (items: ArchivedItem[]) => {
    if (!channelId) return

    // Restore each item's previous status via CAS update
    for (const item of items) {
      try {
        await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${item.slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes: [{ field: 'status', oldValue: 'archived', newValue: item.previousStatus }],
            sender: 'user',
          }),
        })
      } catch (err) {
        console.error(`Failed to restore ${item.slug}:`, err)
      }
    }

    // Refresh tree after undo
    apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
      .then(res => res.json())
      .then(treeData => setTree(treeData.tree || []))
      .catch(console.error)
  }, [channelId, apiHost])

  // Handle artifact creation success (also dismisses archive toast)
  const handleCreateSuccess = useCallback((artifact: Artifact) => {
    setIsCreating(false)
    setSelectedSlug(artifact.slug)
    setArchivedItems([]) // Clear archive toast on creation
    // Refetch tree to include new artifact
    if (channelId) {
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(data => setTree(data.tree || []))
        .catch(console.error)
    }
  }, [channelId, apiHost, setSelectedSlug])

  // Handle artifact update (from ArtifactDetail in-place edit)
  const handleArtifactUpdate = useCallback((artifact: Artifact) => {
    setSelectedArtifactData(artifact)
    // Refetch tree in case status/parent changed
    if (channelId) {
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(data => setTree(data.tree || []))
        .catch(console.error)
    }
  }, [channelId, apiHost])

  // Handle asset upload success
  const handleUploadSuccess = useCallback((asset: Asset) => {
    setIsUploading(false)
    setSelectedSlug(asset.slug)
    // Refetch tree to include new asset
    if (channelId) {
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(data => setTree(data.tree || []))
        .catch(console.error)
    }
  }, [channelId, apiHost, setSelectedSlug])

  // Handle drag-drop upload complete
  const handleDropComplete = useCallback(() => {
    // Refetch tree to include new artifacts
    if (channelId) {
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(data => setTree(data.tree || []))
        .catch(console.error)
    }
  }, [channelId, apiHost])

  // Handle artifact move (drag-drop reordering)
  const handleMove = useCallback(async (
    slug: string,
    newParentSlug: string | null,
    position: 'before' | 'after' | 'into',
    targetSlug?: string
  ) => {
    console.log('[handleMove] Called:', { slug, newParentSlug, position, targetSlug })
    if (!channelId) return

    try {
      // Find the current parent of the artifact being moved
      const findParentSlug = (nodes: typeof tree, target: string, parentSlug: string | null = null): string | null | undefined => {
        for (const node of nodes) {
          if (node.slug === target) return parentSlug
          if (node.children) {
            const found = findParentSlug(node.children, target, node.slug)
            if (found !== undefined) return found
          }
        }
        return undefined
      }

      // Find a node by slug
      const findNode = (nodes: typeof tree, target: string): ArtifactTreeNode | null => {
        for (const node of nodes) {
          if (node.slug === target) return node
          if (node.children) {
            const found = findNode(node.children, target)
            if (found) return found
          }
        }
        return null
      }

      // Get siblings of a node (nodes at the same level with same parent)
      const getSiblings = (parentSlug: string | null): ArtifactTreeNode[] => {
        if (parentSlug === null) {
          // Root level
          return tree
        }
        const parentNode = findNode(tree, parentSlug)
        return parentNode?.children || []
      }

      const currentParentSlug = findParentSlug(tree, slug) ?? null
      const movingNode = findNode(tree, slug)
      // Use ?? to preserve empty string (|| would treat '' as falsy and cause CAS mismatch)
      const currentOrderKey = movingNode?.orderKey ?? null

      console.log('[handleMove] Current state:', { currentParentSlug, currentOrderKey, movingNode })

      // Calculate new orderKey based on position
      let newOrderKey: string | null = null

      // Helper for orderKey comparison - use simple string comparison (not localeCompare)
      // because fractional-indexing generates keys designed for ASCII/Unicode code point ordering
      const compareOrderKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

      if (position === 'into') {
        // Drop as last child of target
        const children = getSiblings(newParentSlug)
          .filter(n => n.slug !== slug) // Exclude the node being moved
          .sort((a, b) => compareOrderKey(a.orderKey ?? '', b.orderKey ?? ''))
        const lastKey = children.length > 0 ? (children[children.length - 1].orderKey ?? null) : null
        newOrderKey = generateKeyBetween(lastKey, null)
      } else if (targetSlug) {
        // Drop before or after target sibling
        const siblings = getSiblings(newParentSlug)
          .filter(n => n.slug !== slug) // Exclude the node being moved
          .sort((a, b) => compareOrderKey(a.orderKey ?? '', b.orderKey ?? ''))

        const targetIndex = siblings.findIndex(n => n.slug === targetSlug)
        if (targetIndex === -1) {
          // Target not found, append at end
          const lastKey = siblings.length > 0 ? (siblings[siblings.length - 1].orderKey ?? null) : null
          newOrderKey = generateKeyBetween(lastKey, null)
        } else if (position === 'before') {
          // generateKeyBetween expects null not undefined, so coalesce
          const prevKey = targetIndex > 0 ? (siblings[targetIndex - 1].orderKey ?? null) : null
          const nextKey = siblings[targetIndex].orderKey ?? null
          newOrderKey = generateKeyBetween(prevKey, nextKey)
        } else {
          // position === 'after'
          const prevKey = siblings[targetIndex].orderKey ?? null
          const nextKey = targetIndex < siblings.length - 1 ? (siblings[targetIndex + 1].orderKey ?? null) : null
          newOrderKey = generateKeyBetween(prevKey, nextKey)
        }
      }

      // Build changes for CAS update
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []

      // Update parentSlug if it changed
      if (newParentSlug !== currentParentSlug) {
        changes.push({
          field: 'parentSlug',
          oldValue: currentParentSlug,
          newValue: newParentSlug,
        })
      }

      // Update orderKey if calculated
      if (newOrderKey && newOrderKey !== currentOrderKey) {
        changes.push({
          field: 'orderKey',
          oldValue: currentOrderKey,
          newValue: newOrderKey,
        })
      }

      console.log('[handleMove] Calculated newOrderKey:', newOrderKey)
      console.log('[handleMove] Changes to send:', changes)

      if (changes.length === 0) {
        console.log('[handleMove] No changes needed, skipping PATCH')
        return
      }

      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes,
          sender: 'user',
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        console.error('[handleMove] PATCH failed:', data.error || 'Unknown error', data)
        return
      }

      console.log('[handleMove] PATCH succeeded, refetching tree')
      // Refetch tree to show new structure
      apiFetch(`${apiHost}/channels/${channelId}/artifacts/tree?pattern=/**&format=json`)
        .then(res => res.json())
        .then(data => setTree(data.tree || []))
        .catch(console.error)
    } catch (err) {
      console.error('Move error:', err)
    }
  }, [channelId, apiHost, tree])

  // ESC key handling is done in ArtifactDetail:
  // - First ESC: cancel editing (return to view mode)
  // - Second ESC: close artifact detail (calls onBack)

  // Track if we're on mobile for responsive width
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768
  )

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  if (!isOpen) return null

  return (
    <aside
      className="relative flex flex-col border-l border-[var(--cast-border-default)] bg-card flex-1 md:flex-none"
      style={{ width: isMobile ? '100%' : `${width}px` }}
    >
      {/* Resize handle - wider hit area with visible indicator (desktop only) */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 group hidden md:block"
        onMouseDown={handleResizeStart}
      >
        {/* Visible indicator line */}
        <div className="absolute left-0 top-0 bottom-0 w-px bg-transparent group-hover:bg-primary/30 transition-colors" />
      </div>

      {/* Hide BoardHeader when viewing artifact detail or creating (iOS-style takeover) */}
      {!selectedArtifactData && !isCreating && (
        <BoardHeader
          onCreateClick={(type) => {
            setCreateType(type)
            setIsCreating(true)
            setArchivedItems([]) // Clear archive toast on create
          }}
          onClose={() => {
            setArchivedItems([]) // Clear archive toast on close
            onClose()
          }}
          canCreate={!!channelId}
          filterVisible={filterVisible}
          onFilterToggle={handleFilterToggle}
          hasActiveFilter={!!filterText}
          onUploadClick={() => {
            setIsUploading(true)
            setArchivedItems([])
          }}
        />
      )}

      {/* Main content area - shows EITHER tree OR detail/create/upload */}
      {/* FileDropZone wraps content when channel is selected and we're in tree view */}
      <FileDropZone
        channelId={channelId || ''}
        apiHost={apiHost}
        onComplete={handleDropComplete}
        disabled={!channelId || isCreating || isUploading || !!selectedArtifactData}
      >
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className={cn(
            "flex-1 min-h-0",
            // Don't add overflow-y-auto when showing artifact detail - let the detail component handle its own scrolling
            selectedArtifactData ? "flex flex-col" : "overflow-y-auto"
          )}>
            {isUploading ? (
              <AssetUpload
                channelId={channelId!}
                apiHost={apiHost}
                onComplete={handleUploadSuccess}
                onCancel={() => setIsUploading(false)}
              />
            ) : isCreating ? (
              <ArtifactDetail
                artifact={undefined}
                channelId={channelId!}
                apiHost={apiHost}
                spaceId={spaceId}
                tree={tree}
                initialType={createType}
                onUpdate={handleCreateSuccess}
                onLinkClick={handleSelect}
                onBack={() => setIsCreating(false)}
              />
            ) : selectedArtifactData ? (
              <ArtifactDetail
                artifact={selectedArtifactData}
                channelId={channelId!}
                apiHost={apiHost}
                spaceId={spaceId}
                tree={tree}
                onUpdate={handleArtifactUpdate}
                onLinkClick={handleSelect}
                onBack={() => setSelectedSlug(null)}
                onArchive={handleArchive}
              />
            ) : !channelId ? (
              <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
                <p className="text-muted-foreground text-base">Select a channel to view artifacts</p>
              </div>
            ) : treeLoading ? (
              <div className="flex items-center justify-center h-20">
                <span className="text-base text-muted-foreground">Loading...</span>
              </div>
            ) : tree.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                {/* Abstract tree illustration using CSS shapes */}
                <div className="mb-8 select-none">
                  {/* Root level items */}
                  <div className="flex flex-col gap-2">
                    {/* First branch with children */}
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm bg-muted-foreground/20" />
                      <div className="w-16 h-2 rounded-full bg-muted-foreground/15" />
                    </div>
                    <div className="flex flex-col gap-1.5 ml-4 pl-3 border-l border-muted-foreground/15">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm bg-muted-foreground/15" />
                        <div className="w-12 h-1.5 rounded-full bg-muted-foreground/10" />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm bg-muted-foreground/15" />
                        <div className="w-10 h-1.5 rounded-full bg-muted-foreground/10" />
                      </div>
                    </div>
                    {/* Second branch with children */}
                    <div className="flex items-center gap-2 mt-1">
                      <div className="w-3 h-3 rounded-sm bg-muted-foreground/20" />
                      <div className="w-14 h-2 rounded-full bg-muted-foreground/15" />
                    </div>
                    <div className="flex flex-col gap-1.5 ml-4 pl-3 border-l border-muted-foreground/15">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm bg-muted-foreground/15" />
                        <div className="w-14 h-1.5 rounded-full bg-muted-foreground/10" />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm bg-muted-foreground/15" />
                        <div className="w-8 h-1.5 rounded-full bg-muted-foreground/10" />
                      </div>
                    </div>
                  </div>
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-3">Board</h3>
                <p className="text-muted-foreground text-base leading-relaxed max-w-[260px]">
                  A shared space to organize documents, files, tasks, and plans while working in the channel.
                </p>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {/* Search filter - collapsible */}
                {filterVisible && (
                  <div className="px-3 py-2 border-b border-[var(--cast-border-default)]">
                    <TreeSearch
                      value={filterInput}
                      onChange={setFilterInput}
                      onClear={handleClearFilter}
                      onEscapeEmpty={() => setFilterVisible(false)}
                      placeholder="Filter artifacts..."
                      autoFocus
                    />
                  </div>
                )}
                {/* Tree */}
                <div className="flex-1 overflow-y-auto">
                  <ArtifactTree
                    nodes={tree}
                    expanded={expanded}
                    selectedSlug={selectedSlug}
                    onToggle={toggleExpanded}
                    onSelect={handleSelect}
                    onActivate={handleSelect}
                    filterText={filterText}
                    onMove={handleMove}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </FileDropZone>

      {/* Archive undo toast - persistent banner at bottom */}
      {archivedItems.length > 0 && (
        <ArchiveToast
          archivedItems={archivedItems}
          onUndo={handleUndoArchive}
          onDismiss={dismissArchiveToast}
        />
      )}

    </aside>
  )
}

// Toggle button component for use in App header
export function BoardToggleButton({ isOpen, onClick }: { isOpen: boolean; onClick: () => void }) {
  return (
    <button
      className="p-1.5 hover:bg-[var(--cast-bg-hover)] transition-colors"
      onClick={onClick}
      title={isOpen ? 'Hide board (⌘⇧B)' : 'Show board (⌘⇧B)'}
    >
      <LayoutGrid className={cn(
        "w-4 h-4",
        isOpen ? "text-primary" : "text-muted-foreground"
      )} />
    </button>
  )
}
