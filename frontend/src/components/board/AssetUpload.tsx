import { useState, useRef, useCallback, useEffect, type ChangeEvent } from 'react'
import { X, CheckCircle, AlertCircle } from 'lucide-react'

export interface Asset {
  slug: string
  url: string
  mimeType: string
  size: number
  tldr: string
}

export type UploadState = 'idle' | 'uploading' | 'success' | 'error'

const MAX_SIZE_BYTES = 500 * 1024 * 1024 // 500MB - presigned URLs bypass Lambda limits

// Files larger than this use presigned URL flow (Lambda has 6MB limit)
const PRESIGNED_THRESHOLD = 5 * 1024 * 1024 // 5MB

interface AssetUploadProps {
  channelId: string
  apiHost: string
  onComplete: (asset: Asset) => void
  onCancel: () => void
}

// Generate slug from filename
function generateSlug(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename
  const ext = lastDot > 0 ? filename.slice(lastDot) : ''

  const sanitized = name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return sanitized + ext.toLowerCase()
}

// Format file size for display
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface UploadItem {
  file: File
  slug: string
  progress: number
  state: 'pending' | 'uploading' | 'success' | 'error'
  error?: string
  asset?: Asset
}

/**
 * Direct asset upload component.
 * Opens file picker immediately, uploads automatically with auto-generated slugs.
 * Supports multiple file selection.
 */
export function AssetUpload({ channelId, apiHost, onComplete, onCancel }: AssetUploadProps) {
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhrRefs = useRef<Map<string, XMLHttpRequest>>(new Map())
  const hasOpenedRef = useRef(false)

  // Open file picker immediately on mount (using ref to prevent double-opening in StrictMode)
  useEffect(() => {
    if (!hasOpenedRef.current) {
      hasOpenedRef.current = true
      // Small delay to ensure component is mounted
      setTimeout(() => {
        fileInputRef.current?.click()
      }, 50)
    }
  }, [])

  // Detect when file picker is cancelled (window regains focus without files selected)
  useEffect(() => {
    let focusTimeout: ReturnType<typeof setTimeout> | null = null

    const handleFocus = () => {
      // Small delay to let the change event fire first if files were selected
      focusTimeout = setTimeout(() => {
        // If we still have no uploads after focus returns, user cancelled
        if (uploads.length === 0 && hasOpenedRef.current) {
          onCancel()
        }
      }, 300)
    }

    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('focus', handleFocus)
      if (focusTimeout) clearTimeout(focusTimeout)
    }
  }, [uploads.length, onCancel])

  // Upload a single file - uses presigned URL for large files
  const uploadFile = useCallback(async (item: UploadItem) => {
    setUploads(prev => prev.map(u =>
      u.slug === item.slug ? { ...u, state: 'uploading' } : u
    ))

    const tldr = `Uploaded file: ${item.file.name}`

    // For large files, use presigned URL flow to bypass Lambda limits
    if (item.file.size > PRESIGNED_THRESHOLD) {
      try {
        // Step 1: Get presigned URL
        const presignResponse = await fetch(`${apiHost}/channels/${channelId}/assets/presign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            slug: item.slug,
            contentType: item.file.type || 'application/octet-stream',
            fileSize: item.file.size,
            tldr,
            sender: 'user',
          }),
        })

        if (!presignResponse.ok) {
          const error = await presignResponse.json().catch(() => ({ error: 'Presign failed' }))
          throw new Error(error.error || `Presign failed (${presignResponse.status})`)
        }

        const presignData = await presignResponse.json()

        // Step 2: Upload directly to S3 using XHR for progress tracking
        const xhr = new XMLHttpRequest()
        xhrRefs.current.set(item.slug, xhr)

        await new Promise<void>((resolve, reject) => {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const progress = Math.round((e.loaded / e.total) * 100)
              setUploads(prev => prev.map(u =>
                u.slug === item.slug ? { ...u, progress } : u
              ))
            }
          }

          xhr.onload = () => {
            xhrRefs.current.delete(item.slug)
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve()
            } else {
              reject(new Error(`S3 upload failed (${xhr.status})`))
            }
          }

          xhr.onerror = () => {
            xhrRefs.current.delete(item.slug)
            reject(new Error('Network error during S3 upload'))
          }

          xhr.open(presignData.method, presignData.uploadUrl)
          // Set headers from presigned response
          Object.entries(presignData.headers || {}).forEach(([key, value]) => {
            xhr.setRequestHeader(key, value as string)
          })
          xhr.send(item.file)
        })

        // Step 3: Confirm upload
        const confirmResponse = await fetch(`${apiHost}/channels/${channelId}/assets/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            slug: presignData.slug,
            tldr,
            sender: 'user',
            contentType: item.file.type || 'application/octet-stream',
          }),
        })

        if (!confirmResponse.ok) {
          const error = await confirmResponse.json().catch(() => ({ error: 'Confirm failed' }))
          throw new Error(error.error || `Confirm failed (${confirmResponse.status})`)
        }

        const response = await confirmResponse.json()
        const asset: Asset = {
          slug: response.slug,
          url: response.url,
          mimeType: response.contentType,
          size: response.fileSize,
          tldr,
        }
        setUploads(prev => prev.map(u =>
          u.slug === item.slug ? { ...u, state: 'success', progress: 100, asset } : u
        ))
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Upload failed'
        setUploads(prev => prev.map(u =>
          u.slug === item.slug ? { ...u, state: 'error', error: errorMsg } : u
        ))
      }
      return
    }

    // For small files, use direct multipart upload
    const formData = new FormData()
    formData.append('file', item.file)
    formData.append('slug', item.slug)
    formData.append('tldr', tldr)
    formData.append('sender', 'user')

    const xhr = new XMLHttpRequest()
    xhrRefs.current.set(item.slug, xhr)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const progress = Math.round((e.loaded / e.total) * 100)
        setUploads(prev => prev.map(u =>
          u.slug === item.slug ? { ...u, progress } : u
        ))
      }
    }

    xhr.onload = () => {
      xhrRefs.current.delete(item.slug)
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText)
          const asset: Asset = {
            slug: response.slug,
            url: response.url,
            mimeType: response.contentType,
            size: response.fileSize,
            tldr,
          }
          setUploads(prev => prev.map(u =>
            u.slug === item.slug ? { ...u, state: 'success', progress: 100, asset } : u
          ))
        } catch {
          setUploads(prev => prev.map(u =>
            u.slug === item.slug ? { ...u, state: 'error', error: 'Invalid response' } : u
          ))
        }
      } else {
        let errorMsg = `Upload failed (${xhr.status})`
        try {
          const response = JSON.parse(xhr.responseText)
          errorMsg = response.error || errorMsg
        } catch { /* ignore */ }
        setUploads(prev => prev.map(u =>
          u.slug === item.slug ? { ...u, state: 'error', error: errorMsg } : u
        ))
      }
    }

    xhr.onerror = () => {
      xhrRefs.current.delete(item.slug)
      setUploads(prev => prev.map(u =>
        u.slug === item.slug ? { ...u, state: 'error', error: 'Network error' } : u
      ))
    }

    xhr.open('POST', `${apiHost}/channels/${channelId}/assets`)
    xhr.withCredentials = true
    xhr.send(formData)
  }, [apiHost, channelId])

  // Handle file selection - start uploads immediately
  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) {
      // User cancelled file picker
      onCancel()
      return
    }

    const newUploads: UploadItem[] = []
    const errors: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      // Validate size
      if (file.size > MAX_SIZE_BYTES) {
        errors.push(`${file.name}: Too large (max 500MB)`)
        continue
      }

      newUploads.push({
        file,
        slug: generateSlug(file.name),
        progress: 0,
        state: 'pending',
      })
    }

    if (newUploads.length === 0 && errors.length > 0) {
      // All files failed validation
      alert(errors.join('\n'))
      onCancel()
      return
    }

    setUploads(newUploads)

    // Start all uploads
    newUploads.forEach(item => {
      uploadFile(item)
    })
  }, [onCancel, uploadFile])

  // Check if all uploads are done
  const allDone = uploads.length > 0 && uploads.every(u => u.state === 'success' || u.state === 'error')
  const successCount = uploads.filter(u => u.state === 'success').length
  const errorCount = uploads.filter(u => u.state === 'error').length

  // Auto-complete when all successful
  useEffect(() => {
    if (allDone && successCount > 0 && errorCount === 0) {
      // All uploads succeeded - complete with first asset
      const firstSuccess = uploads.find(u => u.state === 'success' && u.asset)
      if (firstSuccess?.asset) {
        setTimeout(() => onComplete(firstSuccess.asset!), 300)
      }
    }
  }, [allDone, successCount, errorCount, uploads, onComplete])

  // Handle done button click
  const handleDone = () => {
    const firstSuccess = uploads.find(u => u.state === 'success' && u.asset)
    if (firstSuccess?.asset) {
      onComplete(firstSuccess.asset)
    } else {
      onCancel()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Hidden file input - multiple allowed, any file type */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Header */}
      {uploads.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="font-medium text-base">
            Uploading {uploads.length} file{uploads.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Upload list */}
      {uploads.length > 0 && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {uploads.map((item) => (
            <div
              key={item.slug}
              className="flex items-center gap-2 p-2 bg-secondary/30 rounded-lg"
            >
              {/* Status icon */}
              <div className="flex-shrink-0">
                {item.state === 'success' ? (
                  <CheckCircle className="w-4 h-4 text-green-500" />
                ) : item.state === 'error' ? (
                  <AlertCircle className="w-4 h-4 text-destructive" />
                ) : (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                )}
              </div>

              {/* File info */}
              <div className="flex-1 min-w-0">
                <p className="text-base truncate">{item.file.name}</p>
                <p className="text-base text-muted-foreground">
                  {item.state === 'error' ? (
                    <span className="text-destructive">{item.error}</span>
                  ) : item.state === 'success' ? (
                    <span className="text-green-600">Done</span>
                  ) : (
                    `${formatSize(item.file.size)} • ${item.progress}%`
                  )}
                </p>
              </div>

              {/* Progress bar */}
              {item.state === 'uploading' && (
                <div className="w-16 h-1 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      {allDone && (
        <div className="px-3 py-2 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="text-base text-muted-foreground">
              {successCount} succeeded{errorCount > 0 ? `, ${errorCount} failed` : ''}
            </span>
            <button
              onClick={handleDone}
              className="px-3 py-1.5 text-base rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Loading state while waiting for file picker */}
      {uploads.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-base text-muted-foreground">Select files to upload...</p>
        </div>
      )}
    </div>
  )
}
