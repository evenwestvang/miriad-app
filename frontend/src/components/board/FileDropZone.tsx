import { useState, useCallback, useRef, type DragEvent, type ReactNode } from 'react'
import { FolderUp, CheckCircle, AlertCircle, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'

// Types for file entries with path info
interface FileWithPath {
  file: File
  relativePath: string // e.g., "folder/subfolder/file.png"
}

interface UploadProgress {
  phase: 'idle' | 'scanning' | 'creating-folders' | 'uploading' | 'done'
  totalFiles: number
  uploadedFiles: number
  totalFolders: number
  createdFolders: number
  errors: string[]
  currentFile?: string
}

interface FileDropZoneProps {
  channelId: string
  apiHost: string
  onComplete: () => void
  children: ReactNode
  disabled?: boolean
}

// System files to filter out
const IGNORED_FILES = [
  '.ds_store',
  '.gitignore',
  '.gitkeep',
  'thumbs.db',
  'desktop.ini',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '__macosx',
]

// Check if a file should be ignored
function shouldIgnoreFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return IGNORED_FILES.some(ignored => lower === ignored || lower.endsWith(`/${ignored}`))
}

// Generate slug from path segment
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unnamed'
}

// Generate slug for a file, preserving extension
function fileSlugify(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename
  const ext = lastDot > 0 ? filename.slice(lastDot) : ''
  return slugify(name) + ext.toLowerCase()
}

// Extract unique folder paths from files, sorted by depth (shallow first)
function extractFolderPaths(files: FileWithPath[]): string[] {
  const folders = new Set<string>()

  for (const { relativePath } of files) {
    const parts = relativePath.split('/')
    // Build all parent folder paths
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'))
    }
  }

  // Sort by depth (fewer slashes = shallower)
  return Array.from(folders).sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return a.localeCompare(b)
  })
}

// Recursively read a FileSystemDirectoryEntry
async function readDirectoryEntry(
  entry: FileSystemDirectoryEntry,
  path: string
): Promise<FileWithPath[]> {
  const files: FileWithPath[] = []
  const reader = entry.createReader()

  // Read all entries (may need multiple calls for large directories)
  let entries: FileSystemEntry[] = []
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    entries = entries.concat(batch)
  } while (batch.length > 0)

  for (const childEntry of entries) {
    // Skip system files/folders
    if (shouldIgnoreFile(childEntry.name)) {
      continue
    }

    const childPath = path ? `${path}/${childEntry.name}` : childEntry.name

    if (childEntry.isFile) {
      const fileEntry = childEntry as FileSystemFileEntry
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })
      files.push({ file, relativePath: childPath })
    } else if (childEntry.isDirectory) {
      const subFiles = await readDirectoryEntry(
        childEntry as FileSystemDirectoryEntry,
        childPath
      )
      files.push(...subFiles)
    }
  }

  return files
}

// Get files from DataTransfer, preserving folder structure
async function getFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<FileWithPath[]> {
  const files: FileWithPath[] = []
  const items = dataTransfer.items

  // Try webkitGetAsEntry for folder support
  const entries: FileSystemEntry[] = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.()
    if (entry) {
      entries.push(entry)
    }
  }

  if (entries.length > 0) {
    // Use FileSystem API for folder traversal
    for (const entry of entries) {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject)
        })
        files.push({ file, relativePath: entry.name })
      } else if (entry.isDirectory) {
        const subFiles = await readDirectoryEntry(
          entry as FileSystemDirectoryEntry,
          entry.name
        )
        files.push(...subFiles)
      }
    }
  } else {
    // Fallback: regular files without folder info
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]
      files.push({ file, relativePath: file.name })
    }
  }

  return files
}

/**
 * FileDropZone - Wraps content and handles file/folder drag-and-drop uploads.
 *
 * Features:
 * - Drag overlay when files are dragged over
 * - Folder hierarchy reconstruction via webkitGetAsEntry
 * - Creates folder artifacts (type: doc) before uploading files
 * - Progress indicator during upload
 */
export function FileDropZone({
  channelId,
  apiHost,
  onComplete,
  children,
  disabled = false,
}: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [progress, setProgress] = useState<UploadProgress>({
    phase: 'idle',
    totalFiles: 0,
    uploadedFiles: 0,
    totalFolders: 0,
    createdFolders: 0,
    errors: [],
  })

  const dragCounter = useRef(0)
  const folderSlugMap = useRef<Map<string, string>>(new Map())

  // Create a folder artifact (doc with empty content)
  const createFolderArtifact = useCallback(async (
    folderPath: string,
    parentSlug: string | null
  ): Promise<string | null> => {
    const folderName = folderPath.split('/').pop() || 'folder'
    const slug = slugify(folderPath.replace(/\//g, '-'))

    try {
      // Build payload, only include parentSlug if it's set
      const payload: Record<string, unknown> = {
        slug,
        type: 'folder',
        title: folderName,
        tldr: `Folder: ${folderPath}`,
        content: '',
        status: 'active',
        sender: 'user',
      }
      if (parentSlug) {
        payload.parentSlug = parentSlug
      }

      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (response.ok || response.status === 409) {
        // 409 means already exists, which is fine
        return slug
      }

      console.error('Failed to create folder artifact:', await response.text())
      return null
    } catch (error) {
      console.error('Error creating folder artifact:', error)
      return null
    }
  }, [apiHost, channelId])

  // Upload a single file
  const uploadFile = useCallback(async (
    fileWithPath: FileWithPath,
    parentSlug: string | null
  ): Promise<boolean> => {
    const { file, relativePath } = fileWithPath
    const slug = fileSlugify(file.name)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('slug', slug)
    formData.append('tldr', `Uploaded: ${relativePath}`)
    formData.append('sender', 'user')
    if (parentSlug) {
      formData.append('parentSlug', parentSlug)
    }

    try {
      const response = await fetch(`${apiHost}/channels/${channelId}/assets`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      return response.ok || response.status === 201
    } catch (error) {
      console.error('Error uploading file:', error)
      return false
    }
  }, [apiHost, channelId])

  // Process the drop
  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    dragCounter.current = 0

    if (disabled || !e.dataTransfer) return

    // Ignore internal tree drags (they set text/plain with artifact slug)
    // Only handle external file drops
    if (!e.dataTransfer.types.includes('Files')) {
      return
    }

    e.stopPropagation()

    // Phase 1: Scan files
    setProgress({
      phase: 'scanning',
      totalFiles: 0,
      uploadedFiles: 0,
      totalFolders: 0,
      createdFolders: 0,
      errors: [],
    })

    const files = await getFilesFromDataTransfer(e.dataTransfer)
    if (files.length === 0) {
      setProgress(p => ({ ...p, phase: 'idle' }))
      return
    }

    // Extract folder structure
    const folderPaths = extractFolderPaths(files)
    folderSlugMap.current.clear()

    setProgress({
      phase: 'creating-folders',
      totalFiles: files.length,
      uploadedFiles: 0,
      totalFolders: folderPaths.length,
      createdFolders: 0,
      errors: [],
    })

    // Phase 2: Create folder artifacts (shallow first)
    for (const folderPath of folderPaths) {
      const parts = folderPath.split('/')
      const parentPath = parts.slice(0, -1).join('/')
      const parentSlug = parentPath ? folderSlugMap.current.get(parentPath) || null : null

      const slug = await createFolderArtifact(folderPath, parentSlug)
      if (slug) {
        folderSlugMap.current.set(folderPath, slug)
      }

      setProgress(p => ({
        ...p,
        createdFolders: p.createdFolders + 1,
      }))
    }

    // Phase 3: Upload files
    setProgress(p => ({ ...p, phase: 'uploading' }))

    const errors: string[] = []
    for (const fileWithPath of files) {
      const { relativePath } = fileWithPath

      // Find parent folder slug
      const parts = relativePath.split('/')
      const folderPath = parts.slice(0, -1).join('/')
      const parentSlug = folderPath ? folderSlugMap.current.get(folderPath) || null : null

      setProgress(p => ({ ...p, currentFile: relativePath }))

      const success = await uploadFile(fileWithPath, parentSlug)
      if (!success) {
        errors.push(relativePath)
      }

      setProgress(p => ({
        ...p,
        uploadedFiles: p.uploadedFiles + 1,
        errors,
      }))
    }

    // Done
    setProgress(p => ({ ...p, phase: 'done', currentFile: undefined }))

    // Auto-dismiss after delay if no errors
    if (errors.length === 0) {
      setTimeout(() => {
        setProgress({
          phase: 'idle',
          totalFiles: 0,
          uploadedFiles: 0,
          totalFolders: 0,
          createdFolders: 0,
          errors: [],
        })
        onComplete()
      }, 1500)
    }
  }, [disabled, createFolderArtifact, uploadFile, onComplete])

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    // Only handle external file drops, not internal tree drags
    if (!e.dataTransfer?.types.includes('Files')) return
    e.stopPropagation()
    dragCounter.current++
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    // Only handle external file drops, not internal tree drags
    if (!e.dataTransfer?.types.includes('Files')) return
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    // Only intercept external file drops, not internal tree drags
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const dismissProgress = useCallback(() => {
    setProgress({
      phase: 'idle',
      totalFiles: 0,
      uploadedFiles: 0,
      totalFolders: 0,
      createdFolders: 0,
      errors: [],
    })
    onComplete()
  }, [onComplete])

  const isProcessing = progress.phase !== 'idle'

  return (
    <div
      className="relative flex-1 flex flex-col min-h-0"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {/* Drag overlay */}
      {isDragging && !disabled && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 p-6 border-2 border-dashed border-primary rounded-lg">
            <FolderUp className="w-10 h-10 text-primary" />
            <div className="text-center">
              <p className="font-medium text-foreground">Drop files here</p>
              <p className="text-base text-muted-foreground">
                Folders will preserve their structure
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Progress overlay */}
      {isProcessing && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 p-6 max-w-xs">
            {progress.phase === 'done' ? (
              progress.errors.length === 0 ? (
                <>
                  <CheckCircle className="w-10 h-10 text-green-500" />
                  <p className="font-medium text-foreground">Upload complete!</p>
                  <p className="text-base text-muted-foreground text-center">
                    {progress.uploadedFiles} file{progress.uploadedFiles !== 1 ? 's' : ''} uploaded
                    {progress.totalFolders > 0 && ` in ${progress.totalFolders} folder${progress.totalFolders !== 1 ? 's' : ''}`}
                  </p>
                </>
              ) : (
                <>
                  <AlertCircle className="w-10 h-10 text-amber-500" />
                  <p className="font-medium text-foreground">Upload completed with errors</p>
                  <p className="text-base text-muted-foreground text-center">
                    {progress.uploadedFiles - progress.errors.length} of {progress.uploadedFiles} succeeded
                  </p>
                  <div className="max-h-32 overflow-y-auto text-base text-destructive">
                    {progress.errors.map((err, i) => (
                      <div key={i}>Failed: {err}</div>
                    ))}
                  </div>
                  <button
                    onClick={dismissProgress}
                    className="flex items-center gap-1 px-3 py-1.5 text-base bg-primary text-primary-foreground rounded hover:bg-primary/90"
                  >
                    <X className="w-3 h-3" />
                    Dismiss
                  </button>
                </>
              )
            ) : (
              <>
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="font-medium text-foreground">
                  {progress.phase === 'scanning' && 'Scanning files...'}
                  {progress.phase === 'creating-folders' && (
                    `Creating folders... ${progress.createdFolders}/${progress.totalFolders}`
                  )}
                  {progress.phase === 'uploading' && (
                    `Uploading... ${progress.uploadedFiles}/${progress.totalFiles}`
                  )}
                </p>
                {progress.currentFile && (
                  <p className="text-base text-muted-foreground truncate max-w-full">
                    {progress.currentFile}
                  </p>
                )}
                {/* Progress bar */}
                {progress.phase === 'uploading' && progress.totalFiles > 0 && (
                  <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${(progress.uploadedFiles / progress.totalFiles) * 100}%` }}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
