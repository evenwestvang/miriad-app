import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, LayoutGrid } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import { BoardHeader } from './BoardHeader'
import { ArtifactTree } from './ArtifactTree'
import { ArtifactDetail } from './ArtifactDetail'
import { ArtifactCreate } from './ArtifactCreate'
import { AssetUpload, type Asset } from './AssetUpload'
import { FileDropZone } from './FileDropZone'
import { TreeSearch } from './TreeSearch'
import type { Artifact, ArtifactTreeNode, ArtifactType } from '../../types/artifact'

interface BoardPanelProps {
  channelId: string | null
  isOpen: boolean
  onClose: () => void
  apiHost: string
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
  }, [channelId])

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
  }, [channelId, selectedSlug, apiHost, refreshTrigger])

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

  // Select artifact
  const handleSelect = useCallback((slug: string) => {
    setSelectedSlug(slug)
  }, [setSelectedSlug])

  // Clear filter
  const handleClearFilter = useCallback(() => {
    setFilterInput('')
    setFilterText('')
  }, [])

  // Handle artifact creation success
  const handleCreateSuccess = useCallback((artifact: Artifact) => {
    setIsCreating(false)
    setSelectedSlug(artifact.slug)
    // Refetch tree to include new artifact
    if (channelId) {
      apiFetch(`${apiHost}/channels/${channelId}/artifacts?pattern=/**`)
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
      apiFetch(`${apiHost}/channels/${channelId}/artifacts?pattern=/**`)
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
      apiFetch(`${apiHost}/channels/${channelId}/artifacts?pattern=/**`)
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

  // ESC key closes artifact detail
  useEffect(() => {
    if (!isOpen || !selectedArtifactData) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedSlug(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedArtifactData, setSelectedSlug])

  if (!isOpen) return null

  return (
    <aside
      className="relative flex flex-col border-l border-[var(--cast-border-default)] bg-card"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 transition-colors"
        onMouseDown={handleResizeStart}
      />

      <BoardHeader
        onCreateClick={(type) => {
          setCreateType(type)
          setIsCreating(true)
        }}
        onUploadClick={() => setIsUploading(true)}
        onClose={onClose}
        canCreate={!!channelId}
      />

      {/* Main content area - shows EITHER tree OR detail/create/upload */}
      {/* FileDropZone wraps content when channel is selected and we're in tree view */}
      <FileDropZone
        channelId={channelId || ''}
        apiHost={apiHost}
        onComplete={handleDropComplete}
        disabled={!channelId || isCreating || isUploading || !!selectedArtifactData}
      >
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {isUploading ? (
              <AssetUpload
                channelId={channelId!}
                apiHost={apiHost}
                onComplete={handleUploadSuccess}
                onCancel={() => setIsUploading(false)}
              />
            ) : isCreating ? (
              <ArtifactCreate
                channelId={channelId!}
                apiHost={apiHost}
                tree={tree}
                initialType={createType}
                onSuccess={handleCreateSuccess}
                onCancel={() => setIsCreating(false)}
              />
            ) : selectedArtifactData ? (
              <ArtifactDetail
                artifact={selectedArtifactData}
                channelId={channelId!}
                apiHost={apiHost}
                tree={tree}
                onUpdate={handleArtifactUpdate}
                onLinkClick={handleSelect}
                onBack={() => setSelectedSlug(null)}
              />
            ) : !channelId ? (
              <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
                <p className="text-muted-foreground text-sm">Select a channel to view artifacts</p>
              </div>
            ) : treeLoading ? (
              <div className="flex items-center justify-center h-20">
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            ) : tree.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
                <p className="text-muted-foreground text-sm mb-2">No artifacts yet</p>
                <p className="text-muted-foreground text-xs mb-3">Drop files here or click below</p>
                <button
                  className="flex items-center gap-1 px-3 py-1.5 text-sm border border-[var(--cast-border-default)] hover:bg-[var(--cast-bg-hover)] transition-colors"
                  onClick={() => setIsCreating(true)}
                >
                  <Plus className="w-4 h-4" />
                  Create First Artifact
                </button>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {/* Search filter */}
                <div className="px-3 py-2 border-b border-[var(--cast-border-default)]">
                  <TreeSearch
                    value={filterInput}
                    onChange={setFilterInput}
                    onClear={handleClearFilter}
                    placeholder="Filter artifacts... (/ or ⌘K)"
                  />
                </div>
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
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </FileDropZone>
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
