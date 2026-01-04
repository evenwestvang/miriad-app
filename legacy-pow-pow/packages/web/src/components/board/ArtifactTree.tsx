import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { ChevronRight, ChevronDown, FileText, Code, CheckSquare, FolderOpen, Folder, Plus, Bot, BookOpen, Upload, Loader2, AlertCircle, CheckCircle2, Target, Library, Plug } from 'lucide-react'
import { generateKeyBetween } from 'fractional-indexing'
import { cn } from '@/lib/utils'
import { getArtifactIcon } from '@/lib/artifact-icons'
import { ArtifactSummary, Status } from '@/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { uploadFile, createArtifact } from '@/api'

const ARTIFACT_TYPES = [
  { id: 'task', label: 'Task', icon: CheckSquare },
  { id: 'doc', label: 'Document', icon: FileText },
  { id: 'code', label: 'Code', icon: Code },
  { id: 'knowledgebase', label: 'Knowledge Base', icon: Library },
  { id: 'system.agent', label: 'Agent Definition', icon: Bot },
  { id: 'system.playbook', label: 'Playbook', icon: BookOpen },
  { id: 'system.focus', label: 'Focus', icon: Target },
  { id: 'system.mcp', label: 'MCP Server', icon: Plug },
]

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

interface TreeNode {
  name: string
  path: string
  artifact?: ArtifactSummary
  children: Map<string, TreeNode>
}

interface AddTarget {
  parentSlug: string | null
  orderKey: string
  depth: number
}

interface HoverTargets {
  above: AddTarget
  below: AddTarget
  child: AddTarget
}

type AddZone = 'sibling-above' | 'sibling-below' | 'child'

interface ArtifactTreeProps {
  artifacts: ArtifactSummary[]
  onSelect: (artifact: ArtifactSummary) => void
  selectedPath?: string
  onMove?: (slug: string, newParentSlug: string | null, orderKey: string) => void
  onCreate?: (type: string, slug: string, title: string, parentSlug: string | null, orderKey: string) => void
  channel?: string
  onUploadComplete?: () => void
}

// Single file upload status for multi-file tracking
interface FileUploadStatus {
  fileName: string
  slug: string
  status: 'pending' | 'uploading' | 'success' | 'error'
  progress: number
  error?: string
}

// Multi-file upload state
interface MultiUploadState {
  status: 'idle' | 'uploading' | 'complete'
  files: FileUploadStatus[]
  currentIndex: number
  totalFiles: number
  successCount: number
  errorCount: number
  // For folder upload mode
  folderCount?: number
  foldersCreated?: number
}

// Generate a slug from a filename (preserving extension)
function generateSlugFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename
  const ext = lastDot > 0 ? filename.slice(lastDot) : ''

  const slugifiedName = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slugifiedName + ext.toLowerCase()
}

// Generate unique slugs for multiple files (handles duplicates by adding -1, -2, etc.)
function generateUniqueSlugsForFiles(files: FileWithPath[], existingSlugs: Set<string>): Map<File, string> {
  const slugMap = new Map<File, string>()
  const usedSlugs = new Set(existingSlugs)

  for (const { file } of files) {
    const baseSlug = generateSlugFromFilename(file.name)
    let slug = baseSlug

    // If slug already used, add suffix
    let counter = 1
    const lastDot = baseSlug.lastIndexOf('.')
    const namePart = lastDot > 0 ? baseSlug.slice(0, lastDot) : baseSlug
    const extPart = lastDot > 0 ? baseSlug.slice(lastDot) : ''

    while (usedSlugs.has(slug)) {
      slug = `${namePart}-${counter}${extPart}`
      counter++
    }

    usedSlugs.add(slug)
    slugMap.set(file, slug)
  }

  return slugMap
}

// Type for file entry with path information from folder traversal
interface FileWithPath {
  file: File
  relativePath: string // e.g., "folder/subfolder/file.png"
  pathParts: string[] // e.g., ["folder", "subfolder", "file.png"]
}

// Read all entries from a directory entry using webkitGetAsEntry API
async function readDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dirEntry.createReader()
  const entries: FileSystemEntry[] = []

  // readEntries may not return all entries in one call, so we need to keep calling until empty
  const readBatch = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
  }

  let batch = await readBatch()
  while (batch.length > 0) {
    entries.push(...batch)
    batch = await readBatch()
  }

  return entries
}

// Recursively traverse a FileSystemEntry and collect all files with their paths
async function traverseFileSystemEntry(
  entry: FileSystemEntry,
  basePath: string = ''
): Promise<FileWithPath[]> {
  const results: FileWithPath[] = []

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject)
    })

    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    const pathParts = relativePath.split('/')

    results.push({ file, relativePath, pathParts })
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const currentPath = basePath ? `${basePath}/${entry.name}` : entry.name
    const entries = await readDirectoryEntries(dirEntry)

    for (const childEntry of entries) {
      const childResults = await traverseFileSystemEntry(childEntry, currentPath)
      results.push(...childResults)
    }
  }

  return results
}

// Process DataTransferItemList and extract all files (including from folders)
async function getFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<FileWithPath[]> {
  const items = Array.from(dataTransfer.items)
  const results: FileWithPath[] = []

  for (const item of items) {
    if (item.kind !== 'file') continue

    // Try to get entry for folder detection
    const entry = item.webkitGetAsEntry?.()

    if (entry) {
      const fileResults = await traverseFileSystemEntry(entry)
      results.push(...fileResults)
    } else {
      // Fallback for browsers without webkitGetAsEntry
      const file = item.getAsFile()
      if (file) {
        results.push({
          file,
          relativePath: file.name,
          pathParts: [file.name]
        })
      }
    }
  }

  return results
}

// Extract unique folder paths from a list of files
function extractFolderPaths(files: FileWithPath[]): string[] {
  const folderSet = new Set<string>()

  for (const { pathParts } of files) {
    // Add all parent folders (excluding the file itself)
    for (let i = 1; i < pathParts.length; i++) {
      const folderPath = pathParts.slice(0, i).join('/')
      folderSet.add(folderPath)
    }
  }

  // Sort by depth (shallowest first) so parent folders are created before children
  return Array.from(folderSet).sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    return depthA - depthB
  })
}

// Generate a slug from a folder name
function generateFolderSlug(folderName: string): string {
  return folderName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Create folder artifacts for hierarchy preservation
// Returns a map of folderPath -> artifactSlug for use in file uploads
async function createFolderHierarchy(
  channel: string,
  folderPaths: string[],
  dropTargetParentSlug: string | null,
  createdBy: string
): Promise<Map<string, string>> {
  const folderSlugMap = new Map<string, string>()

  for (const folderPath of folderPaths) {
    const parts = folderPath.split('/')
    const folderName = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join('/')

    // Determine parent slug: either from our created folders or the drop target
    const parentSlug = parentPath
      ? folderSlugMap.get(parentPath) || null
      : dropTargetParentSlug

    const slug = generateFolderSlug(folderName)

    try {
      await createArtifact(channel, {
        slug,
        title: folderName,
        tldr: `Folder: ${folderPath}`,
        type: 'doc',
        content: '',
        parentSlug: parentSlug || undefined,
        createdBy,
      })

      folderSlugMap.set(folderPath, slug)
    } catch (err) {
      // If slug already exists, try with a suffix
      const error = err as Error
      if (error.message.includes('exists') || error.message.includes('409')) {
        const uniqueSlug = `${slug}-${Date.now()}`
        try {
          await createArtifact(channel, {
            slug: uniqueSlug,
            title: folderName,
            tldr: `Folder: ${folderPath}`,
            type: 'doc',
            content: '',
            parentSlug: parentSlug || undefined,
            createdBy,
          })
          folderSlugMap.set(folderPath, uniqueSlug)
        } catch {
          // Skip this folder if we still can't create it
          console.error(`Failed to create folder artifact for ${folderPath}`)
        }
      } else {
        console.error(`Failed to create folder artifact for ${folderPath}:`, error)
      }
    }
  }

  return folderSlugMap
}

const STATUS_COLORS: Record<Status, string> = {
  draft: 'text-yellow-500',
  published: 'text-green-500',
  archived: 'text-muted-foreground',
  pending: 'text-yellow-500',
  in_progress: 'text-blue-500',
  done: 'text-green-500',
  blocked: 'text-red-500',
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
}

function buildTree(artifacts: ArtifactSummary[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() }

  for (const artifact of artifacts) {
    const parts = artifact.path.split('/').filter(p => p)
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const currentPath = '/' + parts.slice(0, i + 1).join('/')

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          children: new Map(),
        })
      }
      current = current.children.get(part)!

      // Mark leaf nodes with artifact data
      if (i === parts.length - 1) {
        current.artifact = artifact
      }
    }
  }

  return root
}

function TreeNodeItem({
  node,
  depth,
  onSelect,
  selectedPath,
  expandedPaths,
  onToggle,
  onMove,
  draggedSlug,
  setDraggedSlug,
  siblings,
  siblingIndex,
  onHover,
  onFileDragOver,
  isFileDragActive,
}: {
  node: TreeNode
  depth: number
  onSelect: (artifact: ArtifactSummary) => void
  selectedPath?: string
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onMove?: (slug: string, newParentSlug: string | null, orderKey: string) => void
  draggedSlug: string | null
  setDraggedSlug: (slug: string | null) => void
  siblings: TreeNode[]
  siblingIndex: number
  onHover: (targets: HoverTargets | null, zone: AddZone, rowTop: number, rowHeight: number) => void
  onFileDragOver?: (e: React.DragEvent, artifactSlug: string, artifactTitle: string) => void
  isFileDragActive?: boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [dropZone, setDropZone] = useState<'above' | 'on' | 'below' | null>(null)
  const hasChildren = node.children.size > 0
  const isExpanded = expandedPaths.has(node.path)
  const isSelected = selectedPath === node.artifact?.path
  const isLeaf = node.artifact !== undefined
  const isDragging = draggedSlug === node.artifact?.slug
  const canDrop = isLeaf && draggedSlug && draggedSlug !== node.artifact?.slug

  const handleDragStart = (e: React.DragEvent) => {
    if (!isLeaf || !node.artifact) return
    e.dataTransfer.setData('text/plain', node.artifact.slug)
    e.dataTransfer.setData('application/x-parent-slug', node.artifact.parentSlug || '')
    e.dataTransfer.effectAllowed = 'move'
    setDraggedSlug(node.artifact.slug)
  }

  const handleDragEnd = () => {
    setDraggedSlug(null)
    setDropZone(null)
  }

  const handleDragOver = (e: React.DragEvent) => {
    // Check if this is a file drag - if so, let parent handle it but update target
    if (isFileDragActive && isLeaf && node.artifact && onFileDragOver) {
      onFileDragOver(e, node.artifact.slug, node.artifact.title || node.name)
      return
    }

    if (!canDrop) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height

    if (y < height * 0.25) {
      setDropZone('above')
    } else if (y > height * 0.75) {
      setDropZone('below')
    } else {
      setDropZone('on')
    }
  }

  const handleDragLeave = () => {
    setDropZone(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const slug = e.dataTransfer.getData('text/plain')
    if (!slug || !onMove || !node.artifact) return

    let newParentSlug: string | null
    let orderKey: string

    if (dropZone === 'on') {
      newParentSlug = node.artifact.slug
      const childrenArr = sortedChildren.filter(c => c.artifact)
      const lastChildKey = childrenArr.length > 0 ? childrenArr[childrenArr.length - 1].artifact!.orderKey : null
      orderKey = generateKeyBetween(lastChildKey, null)
    } else {
      newParentSlug = node.artifact.parentSlug || null
      const leafSiblings = siblings.filter(s => s.artifact)
      const myIndex = leafSiblings.findIndex(s => s.artifact?.slug === node.artifact?.slug)

      if (dropZone === 'above') {
        const prevKey = myIndex > 0 ? leafSiblings[myIndex - 1].artifact!.orderKey : null
        const nextKey = node.artifact.orderKey
        orderKey = generateKeyBetween(prevKey, nextKey)
      } else {
        const prevKey = node.artifact.orderKey
        const nextKey = myIndex < leafSiblings.length - 1 ? leafSiblings[myIndex + 1].artifact!.orderKey : null
        orderKey = generateKeyBetween(prevKey, nextKey)
      }
    }

    onMove(slug, newParentSlug, orderKey)
    setDropZone(null)
  }

  const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
    const aIsFolder = !a.artifact
    const bIsFolder = !b.artifact
    if (aIsFolder && !bIsFolder) return -1
    if (!aIsFolder && bIsFolder) return 1
    if (a.artifact && b.artifact) {
      return a.artifact.orderKey.localeCompare(b.artifact.orderKey)
    }
    return a.name.localeCompare(b.name)
  })

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isLeaf || !node.artifact || !rowRef.current) return

    const rect = rowRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height

    // Calculate all three possible targets
    const leafSiblings = siblings.filter(s => s.artifact)
    const myIndex = leafSiblings.findIndex(s => s.artifact?.slug === node.artifact?.slug)

    // Safe wrapper for generateKeyBetween that handles invalid key ordering
    const safeGenerateKey = (a: string | null, b: string | null): string => {
      try {
        return generateKeyBetween(a, b)
      } catch {
        // If keys are out of order or equal, generate a new key at the end
        return generateKeyBetween(a || b, null)
      }
    }

    // Sibling above: insert before this item
    const prevKeyAbove = myIndex > 0 ? leafSiblings[myIndex - 1].artifact!.orderKey : null
    const above: AddTarget = {
      parentSlug: node.artifact.parentSlug || null,
      orderKey: safeGenerateKey(prevKeyAbove, node.artifact.orderKey),
      depth: depth,
    }

    // Sibling below: insert after this item
    const nextKeyBelow = myIndex < leafSiblings.length - 1 ? leafSiblings[myIndex + 1].artifact!.orderKey : null
    const below: AddTarget = {
      parentSlug: node.artifact.parentSlug || null,
      orderKey: safeGenerateKey(node.artifact.orderKey, nextKeyBelow),
      depth: depth,
    }

    // Child: insert as last child of this item
    const childrenArr = sortedChildren.filter(c => c.artifact)
    const lastChildKey = childrenArr.length > 0 ? childrenArr[childrenArr.length - 1].artifact!.orderKey : null
    const child: AddTarget = {
      parentSlug: node.artifact.slug,
      orderKey: safeGenerateKey(lastChildKey, null),
      depth: depth + 1,
    }

    const targets: HoverTargets = { above, below, child }

    // Determine current zone based on mouse position
    const zone: AddZone = y < height * 0.33 ? 'sibling-above' : y > height * 0.67 ? 'sibling-below' : 'child'

    onHover(targets, zone, rect.top, rect.height)
  }, [isLeaf, node.artifact, siblings, depth, sortedChildren, onHover])

  const handleMouseLeave = useCallback(() => {
    onHover(null, 'sibling-below', 0, 0)
  }, [onHover])

  const Icon = isLeaf
    ? getArtifactIcon(node.artifact!)
    : (hasChildren ? (isExpanded ? FolderOpen : Folder) : Folder)

  return (
    <div>
      <div
        ref={rowRef}
        draggable={isLeaf && !!onMove}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={() => {
          if (isLeaf && node.artifact) {
            onSelect(node.artifact)
          }
        }}
        className={cn(
          'flex items-center gap-1.5 pl-2 pr-8 py-1 text-sm rounded hover:bg-secondary/50 text-left cursor-pointer relative',
          isSelected && 'bg-secondary',
          isDragging && 'opacity-50',
          dropZone === 'on' && 'bg-primary/20 ring-1 ring-primary'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* Drop indicator line with dot - above */}
        {dropZone === 'above' && (
          <div
            className="absolute top-0 right-8 h-0.5 bg-primary flex items-center"
            style={{ left: `${(depth + 1) * 16 + 8}px` }}
          >
            <div className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-primary" />
          </div>
        )}
        {/* Drop indicator line with dot - below */}
        {dropZone === 'below' && (
          <div
            className="absolute bottom-0 right-8 h-0.5 bg-primary flex items-center"
            style={{ left: `${(depth + 1) * 16 + 8}px` }}
          >
            <div className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-primary" />
          </div>
        )}

        {/* Expand/collapse indicator */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.path)
            }}
            className="w-4 h-4 flex items-center justify-center shrink-0 hover:bg-secondary rounded"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}

        {/* Type icon */}
        <Icon className={cn(
          'h-4 w-4 shrink-0',
          isLeaf ? STATUS_COLORS[node.artifact!.status] : 'text-muted-foreground'
        )} />

        {/* Name/title + inline assignees and status */}
        <span className="flex-1 flex items-center gap-1.5 min-w-0">
          <span className="truncate">
            {isLeaf && node.artifact?.title ? node.artifact.title : node.name}
          </span>
          {/* Assignees - inline */}
          {isLeaf && node.artifact?.assignees && node.artifact.assignees.length > 0 && (
            <span className="text-[10px] text-muted-foreground truncate shrink-0">
              @{node.artifact.assignees.join(' @')}
            </span>
          )}
          {/* Task status badge - inline */}
          {isLeaf && node.artifact?.type === 'task' && TASK_STATUS_LABELS[node.artifact.status] && (
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full bg-secondary shrink-0',
              STATUS_COLORS[node.artifact.status]
            )}>
              {TASK_STATUS_LABELS[node.artifact.status]}
            </span>
          )}
        </span>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && sortedChildren.map((child, index) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          onSelect={onSelect}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          onMove={onMove}
          draggedSlug={draggedSlug}
          setDraggedSlug={setDraggedSlug}
          siblings={sortedChildren}
          siblingIndex={index}
          onHover={onHover}
          onFileDragOver={onFileDragOver}
          isFileDragActive={isFileDragActive}
        />
      ))}
    </div>
  )
}

function getDefaultExpandedPaths(artifacts: ArtifactSummary[]): Set<string> {
  const paths = new Set<string>()
  for (const artifact of artifacts) {
    const parts = artifact.path.split('/').filter(p => p)
    for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
      paths.add('/' + parts.slice(0, i + 1).join('/'))
    }
  }
  return paths
}

export function ArtifactTree({ artifacts, onSelect, selectedPath, onMove, onCreate, channel, onUploadComplete }: ArtifactTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const clearTimeoutRef = useRef<number | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Check if knowledgebase already exists (only one per channel allowed)
  const hasKnowledgebase = artifacts.some(a => a.type === 'knowledgebase')
  const availableTypes = hasKnowledgebase
    ? ARTIFACT_TYPES.filter(t => t.id !== 'knowledgebase')
    : ARTIFACT_TYPES
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    getDefaultExpandedPaths(artifacts)
  )
  const [draggedSlug, setDraggedSlug] = useState<string | null>(null)
  const [hoverTargets, setHoverTargets] = useState<HoverTargets | null>(null)
  const [addZone, setAddZone] = useState<AddZone>('sibling-below')
  const [hoverRowTop, setHoverRowTop] = useState(0)
  const [hoverRowHeight, setHoverRowHeight] = useState(0)
  const [isAddHovered, setIsAddHovered] = useState(false)

  // Popover state
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [createStep, setCreateStep] = useState<'type' | 'details'>('type')
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  // Locked target when popover is open (so it doesn't change while typing)
  const [lockedTarget, setLockedTarget] = useState<{ target: AddTarget; zone: AddZone; buttonY: number; rowTop: number; rowHeight: number } | null>(null)

  // Upload state
  const [uploadState, setUploadState] = useState<MultiUploadState>({
    status: 'idle',
    files: [],
    currentIndex: 0,
    totalFiles: 0,
    successCount: 0,
    errorCount: 0,
  })
  const [uploadParentSlug, setUploadParentSlug] = useState<string | null>(null)

  // File drag-drop state
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const [fileDragTarget, setFileDragTarget] = useState<{ parentSlug: string | null; targetName: string } | null>(null)
  const dragCounterRef = useRef(0) // Track nested drag enter/leave events

  // Auto-generate slug from name
  useEffect(() => {
    if (!slugEdited && newName) {
      setNewSlug(generateSlug(newName))
    }
  }, [newName, slugEdited])

  useEffect(() => {
    setExpandedPaths(prev => {
      const newPaths = getDefaultExpandedPaths(artifacts)
      const merged = new Set(prev)
      for (const path of newPaths) {
        if (!prev.has(path)) {
          merged.add(path)
        }
      }
      return merged.size !== prev.size ? merged : prev
    })
  }, [artifacts])

  const tree = useMemo(() => buildTree(artifacts), [artifacts])

  const handleToggle = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const handleHover = useCallback((targets: HoverTargets | null, zone: AddZone, rowTop: number, rowHeight: number) => {
    // Cancel any pending clear
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current)
      clearTimeoutRef.current = null
    }

    if (targets) {
      // Immediately set new targets
      setHoverTargets(targets)
      setAddZone(zone)
      setHoverRowTop(rowTop)
      setHoverRowHeight(rowHeight)
    } else {
      // Delay clearing to allow mouse to move to + button
      clearTimeoutRef.current = window.setTimeout(() => {
        setHoverTargets(null)
        clearTimeoutRef.current = null
      }, 50)
    }
  }, [])

  // Get current target based on zone
  const currentTarget = hoverTargets ? (
    addZone === 'sibling-above' ? hoverTargets.above :
    addZone === 'sibling-below' ? hoverTargets.below :
    hoverTargets.child
  ) : null

  // Popover handlers
  const resetPopover = useCallback(() => {
    setCreateStep('type')
    setSelectedType(null)
    setNewName('')
    setNewSlug('')
    setSlugEdited(false)
  }, [])

  const handleTypeSelect = useCallback((type: string) => {
    // Knowledgebase: create directly without dialog (slug must be 'knowledgebase')
    if (type === 'knowledgebase' && onCreate) {
      onCreate('knowledgebase', 'knowledgebase', 'Knowledge Base', null)
      setPopoverOpen(false)
      resetPopover()
      setLockedTarget(null)
      return
    }
    setSelectedType(type)
    setCreateStep('details')
    setTimeout(() => nameInputRef.current?.focus(), 0)
  }, [onCreate, resetPopover])

  const handleCreate = useCallback(() => {
    const target = lockedTarget?.target || currentTarget
    if (!selectedType || !newName.trim() || !newSlug.trim() || !target || !onCreate) return
    onCreate(selectedType, newSlug.trim(), newName.trim(), target.parentSlug, target.orderKey)
    setPopoverOpen(false)
    resetPopover()
    setLockedTarget(null)
  }, [selectedType, newName, newSlug, currentTarget, lockedTarget, onCreate, resetPopover])

  const handlePopoverKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || createStep === 'details')) {
      e.preventDefault()
      handleCreate()
    }
    if (e.key === 'Escape') {
      if (createStep === 'details') {
        resetPopover()
      } else {
        setPopoverOpen(false)
      }
    }
  }, [createStep, handleCreate, resetPopover])

  const handlePopoverOpenChange = useCallback((open: boolean) => {
    setPopoverOpen(open)
    if (!open) {
      resetPopover()
      setLockedTarget(null)
    }
  }, [resetPopover])

  // Upload handlers
  const handleUploadClick = useCallback((parentSlug: string | null) => {
    setUploadParentSlug(parentSlug)
    setPopoverOpen(false)
    // Trigger file input click
    fileInputRef.current?.click()
  }, [])

  // Process multiple files sequentially with progress tracking
  const processMultipleFiles = useCallback(async (
    filesWithPaths: FileWithPath[],
    parentSlug: string | null,
    folderSlugMap?: Map<string, string>
  ) => {
    if (filesWithPaths.length === 0 || !channel) return

    // Get existing artifact slugs to avoid collisions
    const existingSlugs = new Set(artifacts.map(a => a.slug))

    // Generate unique slugs for all files
    const slugMap = generateUniqueSlugsForFiles(filesWithPaths, existingSlugs)

    // Initialize upload state for all files
    const fileStatuses: FileUploadStatus[] = filesWithPaths.map(({ file }) => ({
      fileName: file.name,
      slug: slugMap.get(file) || generateSlugFromFilename(file.name),
      status: 'pending' as const,
      progress: 0,
    }))

    setUploadState({
      status: 'uploading',
      files: fileStatuses,
      currentIndex: 0,
      totalFiles: filesWithPaths.length,
      successCount: 0,
      errorCount: 0,
    })

    let successCount = 0
    let errorCount = 0

    // Process files sequentially
    for (let i = 0; i < filesWithPaths.length; i++) {
      const { file, pathParts } = filesWithPaths[i]
      const slug = slugMap.get(file) || generateSlugFromFilename(file.name)

      // Determine parent slug for this file
      let fileParentSlug = parentSlug
      if (folderSlugMap && pathParts.length > 1) {
        const parentFolderPath = pathParts.slice(0, -1).join('/')
        fileParentSlug = folderSlugMap.get(parentFolderPath) || parentSlug
      }

      // Update current file to uploading
      setUploadState(prev => ({
        ...prev,
        currentIndex: i,
        files: prev.files.map((f, idx) =>
          idx === i ? { ...f, status: 'uploading' as const, progress: 0 } : f
        ),
      }))

      try {
        await uploadFile(
          channel,
          file,
          {
            slug,
            parentSlug: fileParentSlug || undefined,
          },
          (progress) => {
            setUploadState(prev => ({
              ...prev,
              files: prev.files.map((f, idx) =>
                idx === i ? { ...f, progress } : f
              ),
            }))
          }
        )

        successCount++
        setUploadState(prev => ({
          ...prev,
          successCount,
          files: prev.files.map((f, idx) =>
            idx === i ? { ...f, status: 'success' as const, progress: 100 } : f
          ),
        }))
      } catch (err) {
        const error = err as Error & { code?: string }
        let errorMessage = error.message

        if (error.code === 'SLUG_EXISTS' || error.message.includes('409')) {
          errorMessage = `File "${slug}" already exists`
        } else if (error.code === 'FILE_TOO_LARGE' || error.message.includes('413')) {
          errorMessage = 'File is too large (max 50MB)'
        }

        errorCount++
        setUploadState(prev => ({
          ...prev,
          errorCount,
          files: prev.files.map((f, idx) =>
            idx === i ? { ...f, status: 'error' as const, progress: 0, error: errorMessage } : f
          ),
        }))
        // Continue with remaining files (partial failure handling)
      }
    }

    // Mark upload as complete
    setUploadState(prev => ({
      ...prev,
      status: 'complete',
    }))

    // Notify parent to refresh artifacts
    if (successCount > 0) {
      onUploadComplete?.()
    }

    // Reset after showing results
    setTimeout(() => {
      setUploadState({
        status: 'idle',
        files: [],
        currentIndex: 0,
        totalFiles: 0,
        successCount: 0,
        errorCount: 0,
      })
    }, errorCount > 0 ? 5000 : 2500)
  }, [channel, artifacts, onUploadComplete])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0 || !channel) return

    // Convert FileList to FileWithPath array BEFORE resetting input
    // (resetting clears the FileList since it's a live reference)
    const filesWithPaths: FileWithPath[] = Array.from(fileList).map(file => ({
      file,
      relativePath: file.name,
      pathParts: [file.name],
    }))

    // Reset input so same files can be selected again
    e.target.value = ''

    await processMultipleFiles(filesWithPaths, uploadParentSlug)
  }, [channel, uploadParentSlug, processMultipleFiles])

  // Helper to check if a drag event contains files (not internal artifact drag)
  const isFileDrag = useCallback((e: React.DragEvent): boolean => {
    // Check if this is an external file drag (from OS) vs internal artifact reorder
    // Internal drags set 'text/plain' with the artifact slug
    // External file drags have 'Files' in the types
    const types = Array.from(e.dataTransfer.types)
    const hasFiles = types.includes('Files')
    const hasArtifactSlug = types.includes('text/plain') && draggedSlug !== null
    return hasFiles && !hasArtifactSlug
  }, [draggedSlug])

  // File drag handlers for the container
  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isFileDrag(e) || !channel) return

    dragCounterRef.current++
    if (dragCounterRef.current === 1) {
      setIsFileDragOver(true)
      setFileDragTarget({ parentSlug: null, targetName: 'root' })
    }
  }, [isFileDrag, channel])

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsFileDragOver(false)
      setFileDragTarget(null)
    }
  }, [])

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isFileDrag(e)) return

    e.dataTransfer.dropEffect = 'copy'
  }, [isFileDrag])

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    dragCounterRef.current = 0
    setIsFileDragOver(false)

    if (!channel) return

    const dropTargetParentSlug = fileDragTarget?.parentSlug || null
    setFileDragTarget(null)

    // Use webkitGetAsEntry for folder support
    const filesWithPaths = await getFilesFromDataTransfer(e.dataTransfer)
    if (filesWithPaths.length === 0) return

    // Check if this includes folders (files with path depth > 1)
    const hasFolders = filesWithPaths.some(f => f.pathParts.length > 1)

    if (hasFolders) {
      // Folder upload flow: create hierarchy first, then use batch processor
      const folderPaths = extractFolderPaths(filesWithPaths)
      const folderCount = folderPaths.length

      // Initialize state to show folder creation phase
      setUploadState({
        status: 'uploading',
        files: [],
        currentIndex: 0,
        totalFiles: filesWithPaths.length,
        successCount: 0,
        errorCount: 0,
        folderCount,
        foldersCreated: 0,
      })

      // Step 1: Create folder artifacts for hierarchy
      const folderSlugMap = await createFolderHierarchy(
        channel,
        folderPaths,
        dropTargetParentSlug,
        'upload'
      )

      // Step 2: Use batch processor for files with folder slug map
      await processMultipleFiles(filesWithPaths, dropTargetParentSlug, folderSlugMap)
    } else {
      // Multi-file drop (no folder structure) - use batch processor directly
      await processMultipleFiles(filesWithPaths, dropTargetParentSlug)
    }
  }, [channel, fileDragTarget, processMultipleFiles])

  // Handler for dropping files onto a specific artifact (to set as parent)
  const handleArtifactFileDragOver = useCallback((e: React.DragEvent, artifactSlug: string, artifactTitle: string) => {
    if (!isFileDrag(e)) return

    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setFileDragTarget({ parentSlug: artifactSlug, targetName: artifactTitle || artifactSlug })
  }, [isFileDrag])

  const canCreate = selectedType && newName.trim() && newSlug.trim()

  const sortedChildren = Array.from(tree.children.values()).sort((a, b) => {
    const aIsFolder = !a.artifact
    const bIsFolder = !b.artifact
    if (aIsFolder && !bIsFolder) return -1
    if (!aIsFolder && bIsFolder) return 1
    if (a.artifact && b.artifact) {
      return a.artifact.orderKey.localeCompare(b.artifact.orderKey)
    }
    return a.name.localeCompare(b.name)
  })

  // Calculate add button position relative to container
  // Container-level mouse tracking for zone calculation
  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (!hoverTargets) return

    const y = e.clientY - hoverRowTop
    const height = hoverRowHeight

    const newZone: AddZone = y < height * 0.33 ? 'sibling-above'
      : y > height * 0.67 ? 'sibling-below'
      : 'child'

    if (newZone !== addZone) {
      setAddZone(newZone)
    }
  }, [hoverTargets, hoverRowTop, hoverRowHeight, addZone])

  const containerRect = containerRef.current?.getBoundingClientRect()
  const addButtonTop = containerRect ? hoverRowTop - containerRect.top : 0
  // Position button based on zone: above (top), child (middle), below (bottom)
  const addButtonY = addZone === 'sibling-above'
    ? addButtonTop - 2  // Near top of row
    : addZone === 'sibling-below'
      ? addButtonTop + hoverRowHeight - 18  // Near bottom of row
      : addButtonTop + hoverRowHeight / 2 - 10  // Centered for child

  // For empty state, set a default target
  const emptyStateTarget: AddTarget = {
    parentSlug: null,
    orderKey: generateKeyBetween(null, null),
    depth: 0,
  }

  if (artifacts.length === 0) {
    return (
      <div
        className={cn(
          "flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm p-4 gap-2 relative transition-colors",
          isFileDragOver && "bg-primary/5 border-2 border-dashed border-primary rounded-lg"
        )}
        onDragEnter={handleFileDragEnter}
        onDragLeave={handleFileDragLeave}
        onDragOver={handleFileDragOver}
        onDrop={handleFileDrop}
      >
        {isFileDragOver ? (
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-8 w-8 text-primary animate-pulse" />
            <span className="text-primary font-medium">Drop file to upload</span>
          </div>
        ) : (
          <span>No artifacts yet</span>
        )}
        {onCreate && (
          <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-1 text-xs text-primary hover:underline">
                <Plus className="h-3 w-3" />
                Create one
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" onKeyDown={handlePopoverKeyDown}>
              {createStep === 'type' ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground px-2 py-1">
                    New artifact
                  </div>
                  {availableTypes.map((type) => (
                    <button
                      key={type.id}
                      onClick={() => handleTypeSelect(type.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-secondary text-left"
                    >
                      <type.icon className="h-4 w-4 text-muted-foreground" />
                      {type.label}
                    </button>
                  ))}
                  {channel && (
                    <>
                      <div className="border-t my-1" />
                      <button
                        onClick={() => handleUploadClick(emptyStateTarget.parentSlug)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-secondary text-left"
                      >
                        <Upload className="h-4 w-4 text-muted-foreground" />
                        Upload File
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground px-1">
                    {availableTypes.find(t => t.id === selectedType)?.icon && (
                      (() => {
                        const Icon = availableTypes.find(t => t.id === selectedType)!.icon
                        return <Icon className="h-3 w-3" />
                      })()
                    )}
                    New {availableTypes.find(t => t.id === selectedType)?.label}
                  </div>
                  <div className="space-y-2">
                    <Input
                      ref={nameInputRef}
                      placeholder="Name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <Input
                      placeholder="slug"
                      value={newSlug}
                      onChange={(e) => {
                        setSlugEdited(true)
                        setNewSlug(e.target.value)
                      }}
                      className={cn(
                        'h-8 text-sm font-mono text-xs',
                        !slugEdited && 'text-muted-foreground'
                      )}
                    />
                  </div>
                  <div className="flex justify-between items-center pt-1">
                    <button
                      onClick={resetPopover}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Back
                    </button>
                    <Button
                      size="sm"
                      disabled={!canCreate}
                      onClick={() => {
                        if (!selectedType || !newName.trim() || !newSlug.trim()) return
                        onCreate(selectedType, newSlug.trim(), newName.trim(), emptyStateTarget.parentSlug, emptyStateTarget.orderKey)
                        setPopoverOpen(false)
                        resetPopover()
                      }}
                      className="h-7 text-xs"
                    >
                      Create
                    </Button>
                  </div>
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}

        {/* Hidden file input for uploads - supports multiple files (also needed in empty state) */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Multi-file upload progress indicator */}
        {uploadState.status !== 'idle' && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg shadow-lg p-3 min-w-[300px] max-w-[400px] z-50">
            {/* Overall progress header */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {uploadState.status === 'uploading' && (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                )}
                {uploadState.status === 'complete' && uploadState.errorCount === 0 && (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                )}
                {uploadState.status === 'complete' && uploadState.errorCount > 0 && (
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                )}
                <span className="text-sm font-medium">
                  {uploadState.status === 'uploading'
                    ? uploadState.files.length === 0 && uploadState.folderCount
                      ? `Creating ${uploadState.folderCount} folders...`
                      : `Uploading ${uploadState.currentIndex + 1} of ${uploadState.totalFiles}`
                    : uploadState.errorCount > 0
                      ? `Uploaded ${uploadState.successCount} of ${uploadState.totalFiles}`
                      : `Uploaded ${uploadState.totalFiles} file${uploadState.totalFiles !== 1 ? 's' : ''}`
                  }
                </span>
              </div>
              {uploadState.status === 'complete' && (
                <button
                  onClick={() => setUploadState({
                    status: 'idle',
                    files: [],
                    currentIndex: 0,
                    totalFiles: 0,
                    successCount: 0,
                    errorCount: 0,
                  })}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Dismiss
                </button>
              )}
            </div>

            {/* File list with status */}
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {uploadState.files.map((file, index) => (
                <div key={index} className="flex items-center gap-2 text-xs">
                  {file.status === 'pending' && (
                    <div className="h-3 w-3 rounded-full bg-muted" />
                  )}
                  {file.status === 'uploading' && (
                    <Loader2 className="h-3 w-3 animate-spin text-primary" />
                  )}
                  {file.status === 'success' && (
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                  )}
                  {file.status === 'error' && (
                    <AlertCircle className="h-3 w-3 text-red-500" />
                  )}
                  <span className={cn(
                    "truncate flex-1",
                    file.status === 'error' && "text-red-500"
                  )}>
                    {file.fileName}
                  </span>
                  {file.status === 'uploading' && (
                    <span className="text-muted-foreground">{file.progress}%</span>
                  )}
                  {file.status === 'error' && file.error && (
                    <span className="text-red-500 truncate max-w-[100px]" title={file.error}>
                      {file.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "py-1 relative transition-colors",
        isFileDragOver && "bg-primary/5"
      )}
      onMouseMove={handleContainerMouseMove}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* File drop overlay */}
      {isFileDragOver && (
        <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
          <div className="bg-background/90 border-2 border-dashed border-primary rounded-lg p-6 flex flex-col items-center gap-2">
            <Upload className="h-8 w-8 text-primary animate-pulse" />
            <span className="text-primary font-medium">
              {fileDragTarget?.parentSlug
                ? `Drop into "${fileDragTarget.targetName}"`
                : 'Drop file to upload'}
            </span>
          </div>
        </div>
      )}

      {sortedChildren.map((child, index) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={0}
          onSelect={onSelect}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onToggle={handleToggle}
          onMove={onMove}
          draggedSlug={draggedSlug}
          setDraggedSlug={setDraggedSlug}
          siblings={sortedChildren}
          siblingIndex={index}
          onHover={handleHover}
          onFileDragOver={handleArtifactFileDragOver}
          isFileDragActive={isFileDragOver}
        />
      ))}

      {/* Floating add button with popover */}
      {onCreate && (hoverTargets || lockedTarget) && (
        <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
          <PopoverTrigger asChild>
            <button
              onMouseEnter={() => {
                if (clearTimeoutRef.current) {
                  clearTimeout(clearTimeoutRef.current)
                  clearTimeoutRef.current = null
                }
                setIsAddHovered(true)
              }}
              onMouseLeave={() => setIsAddHovered(false)}
              onClick={() => {
                // Lock the current target when opening the popover
                if (currentTarget && !lockedTarget) {
                  setLockedTarget({ target: currentTarget, zone: addZone, buttonY: addButtonY, rowTop: addButtonTop, rowHeight: hoverRowHeight })
                }
              }}
              className={cn(
                'absolute right-1 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary',
                isAddHovered && 'text-primary'
              )}
              style={{ top: `${lockedTarget ? lockedTarget.buttonY : addButtonY}px` }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 p-2"
            onKeyDown={handlePopoverKeyDown}
          >
            {createStep === 'type' ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground px-2 py-1">
                  New artifact
                  {(lockedTarget?.zone === 'child' || (!lockedTarget && addZone === 'child')) && (
                    <span className="text-primary ml-1">(child)</span>
                  )}
                </div>
                {availableTypes.map((type) => (
                  <button
                    key={type.id}
                    onClick={() => handleTypeSelect(type.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-secondary text-left"
                  >
                    <type.icon className="h-4 w-4 text-muted-foreground" />
                    {type.label}
                  </button>
                ))}
                {channel && (
                  <>
                    <div className="border-t my-1" />
                    <button
                      onClick={() => handleUploadClick((lockedTarget?.target || currentTarget)?.parentSlug || null)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-secondary text-left"
                    >
                      <Upload className="h-4 w-4 text-muted-foreground" />
                      Upload File
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground px-1">
                  {availableTypes.find(t => t.id === selectedType)?.icon && (
                    (() => {
                      const Icon = availableTypes.find(t => t.id === selectedType)!.icon
                      return <Icon className="h-3 w-3" />
                    })()
                  )}
                  New {availableTypes.find(t => t.id === selectedType)?.label}
                </div>
                <div className="space-y-2">
                  <Input
                    ref={nameInputRef}
                    placeholder="Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Input
                    placeholder="slug"
                    value={newSlug}
                    onChange={(e) => {
                      setSlugEdited(true)
                      setNewSlug(e.target.value)
                    }}
                    className={cn(
                      'h-8 text-sm font-mono text-xs',
                      !slugEdited && 'text-muted-foreground'
                    )}
                  />
                </div>
                <div className="flex justify-between items-center pt-1">
                  <button
                    onClick={resetPopover}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Back
                  </button>
                  <Button
                    size="sm"
                    disabled={!canCreate}
                    onClick={handleCreate}
                    className="h-7 text-xs"
                  >
                    Create
                  </Button>
                </div>
                <div className="text-[10px] text-muted-foreground text-center">
                  Press <kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">Cmd</kbd>+<kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">Enter</kbd> to create
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}

      {/* Add indicator line - shown when hovering the + button or popover is open */}
      {(isAddHovered || popoverOpen) && (lockedTarget || currentTarget) && (() => {
        const effectiveZone = lockedTarget?.zone || addZone
        const effectiveRowTop = lockedTarget?.rowTop ?? addButtonTop
        const effectiveRowHeight = lockedTarget?.rowHeight ?? hoverRowHeight
        const effectiveDepth = (lockedTarget?.target || currentTarget)!.depth
        return (
          <div
            className="absolute right-8 h-0.5 bg-primary pointer-events-none"
            style={{
              top: effectiveZone === 'sibling-above'
                ? `${effectiveRowTop}px`
                : `${effectiveRowTop + effectiveRowHeight}px`,
              left: `${(effectiveDepth + 1) * 16 + 8}px`
            }}
          >
            {effectiveZone === 'child' && (
              <div className="absolute left-0 -top-3 w-0.5 h-[14px] bg-primary" />
            )}
          </div>
        )
      })()}

      {/* Hidden file input for uploads - supports multiple files */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Multi-file upload progress indicator */}
      {uploadState.status !== 'idle' && (
        <div className="fixed bottom-4 right-4 bg-background border rounded-lg shadow-lg p-3 min-w-[300px] max-w-[400px] z-50">
          {/* Overall progress header */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {uploadState.status === 'uploading' && (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
              {uploadState.status === 'complete' && uploadState.errorCount === 0 && (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
              {uploadState.status === 'complete' && uploadState.errorCount > 0 && (
                <AlertCircle className="h-4 w-4 text-yellow-500" />
              )}
              <span className="text-sm font-medium">
                {uploadState.status === 'uploading'
                  ? uploadState.files.length === 0 && uploadState.folderCount
                    ? `Creating ${uploadState.folderCount} folders...`
                    : `Uploading ${uploadState.currentIndex + 1} of ${uploadState.totalFiles}`
                  : uploadState.errorCount === 0
                    ? `${uploadState.successCount} file${uploadState.successCount !== 1 ? 's' : ''} uploaded`
                    : `${uploadState.successCount} uploaded, ${uploadState.errorCount} failed`
                }
              </span>
            </div>
          </div>

          {/* Per-file progress list */}
          {uploadState.files.length > 0 && (
            <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
              {uploadState.files.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  {file.status === 'pending' && (
                    <div className="w-3 h-3 rounded-full border border-muted-foreground" />
                  )}
                  {file.status === 'uploading' && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  )}
                  {file.status === 'success' && (
                    <CheckCircle2 className="w-3 h-3 text-green-500" />
                  )}
                  {file.status === 'error' && (
                    <AlertCircle className="w-3 h-3 text-red-500" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "truncate",
                        file.status === 'error' && "text-red-500",
                        file.status === 'success' && "text-green-600",
                        file.status === 'pending' && "text-muted-foreground"
                      )}>
                        {file.fileName}
                      </span>
                      {file.status === 'uploading' && (
                        <span className="text-muted-foreground shrink-0">{file.progress}%</span>
                      )}
                    </div>
                    {file.status === 'uploading' && (
                      <div className="h-1 bg-secondary rounded-full overflow-hidden mt-0.5">
                        <div
                          className="h-full bg-primary transition-all duration-200"
                          style={{ width: `${file.progress}%` }}
                        />
                      </div>
                    )}
                    {file.status === 'error' && file.error && (
                      <div className="text-red-500 text-[10px] truncate">{file.error}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
