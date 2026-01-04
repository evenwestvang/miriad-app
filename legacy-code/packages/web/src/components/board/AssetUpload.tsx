import { useState, useRef, useCallback, type ChangeEvent } from 'react'
import { AssetUploadForm } from './AssetUploadForm'
import { AssetUploadProgress } from './AssetUploadProgress'

export interface Asset {
  slug: string
  url: string
  mimeType: string
  size: number
  tldr: string
}

export type UploadState = 'idle' | 'form' | 'uploading' | 'success' | 'error'

// Allowed file types
const ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'image/webp',
  'application/pdf',
]

const ALLOWED_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.svg,.webp,.pdf'
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

interface AssetUploadProps {
  channelId: string
  apiHost: string
  onComplete: (asset: Asset) => void
  onCancel: () => void
}

/**
 * Main asset upload component.
 * Manages upload state machine: idle -> form -> uploading -> success/error
 */
export function AssetUpload({ channelId, apiHost, onComplete, onCancel }: AssetUploadProps) {
  const [state, setState] = useState<UploadState>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  // Reset to initial state
  const reset = useCallback(() => {
    setState('idle')
    setFile(null)
    setProgress(0)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [])

  // Handle file selection
  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (!selected) return

    // Validate size
    if (selected.size > MAX_SIZE_BYTES) {
      const sizeMB = (selected.size / (1024 * 1024)).toFixed(1)
      setError(`File too large (${sizeMB}MB). Maximum size is 10MB.`)
      setState('error')
      return
    }

    // Validate type
    if (!ALLOWED_TYPES.includes(selected.type)) {
      setError('File type not supported. Allowed: PNG, JPG, GIF, SVG, WebP, PDF')
      setState('error')
      return
    }

    setFile(selected)
    setError(null)
    setState('form')
  }, [])

  // Trigger file picker
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Upload the file
  const handleUpload = useCallback(async (slug: string, tldr: string) => {
    if (!file) return

    setState('uploading')
    setProgress(0)
    setError(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('slug', slug)
    if (tldr) formData.append('tldr', tldr)

    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText)
          setState('success')
          // Brief delay to show success, then complete
          setTimeout(() => onComplete(response.asset), 500)
        } catch {
          setError('Invalid response from server')
          setState('error')
        }
      } else {
        try {
          const response = JSON.parse(xhr.responseText)
          setError(response.error || `Upload failed (${xhr.status})`)
        } catch {
          setError(`Upload failed (${xhr.status})`)
        }
        setState('error')
      }
    }

    xhr.onerror = () => {
      setError('Network error. Please check your connection and try again.')
      setState('error')
    }

    xhr.onabort = () => {
      reset()
    }

    xhr.open('POST', `${apiHost}/channels/${channelId}/assets`)
    xhr.send(formData)
  }, [file, channelId, apiHost, onComplete, reset])

  // Cancel upload in progress
  const handleCancelUpload = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort()
      xhrRef.current = null
    }
    reset()
  }, [reset])

  // Retry after error
  const handleRetry = useCallback(() => {
    if (file) {
      setState('form')
      setError(null)
    } else {
      reset()
    }
  }, [file, reset])

  return (
    <div className="flex flex-col h-full">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS}
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* State-based content */}
      {state === 'idle' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <p className="text-sm text-muted-foreground mb-3">
            Upload an image or PDF to the board
          </p>
          <button
            onClick={openFilePicker}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Choose File
          </button>
          <p className="text-xs text-muted-foreground mt-2">
            PNG, JPG, GIF, SVG, WebP, PDF (max 10MB)
          </p>
        </div>
      )}

      {state === 'form' && file && (
        <AssetUploadForm
          file={file}
          channelId={channelId}
          apiHost={apiHost}
          onUpload={handleUpload}
          onCancel={onCancel}
          onChangeFile={openFilePicker}
        />
      )}

      {state === 'uploading' && file && (
        <AssetUploadProgress
          fileName={file.name}
          progress={progress}
          onCancel={handleCancelUpload}
        />
      )}

      {state === 'success' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm font-medium text-green-600">Upload complete!</p>
        </div>
      )}

      {state === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-destructive mb-1">Upload failed</p>
          <p className="text-xs text-muted-foreground text-center mb-4">{error}</p>
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Try Again
            </button>
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded-md hover:bg-secondary/50 text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
