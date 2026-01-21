import { useState, useEffect, useCallback } from 'react'
import { FileText, Image, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'

interface AssetUploadFormProps {
  file: File
  channelId: string
  apiHost: string
  onUpload: (slug: string, tldr: string) => void
  onCancel: () => void
  onChangeFile: () => void
}

// Generate slug from filename
function generateSlug(filename: string): string {
  // Keep the extension
  const lastDot = filename.lastIndexOf('.')
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename
  const ext = lastDot > 0 ? filename.slice(lastDot) : ''

  // Sanitize: lowercase, replace spaces/underscores with hyphens, remove invalid chars
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

// Get icon based on mime type
function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) {
    return <Image className="w-8 h-8 text-blue-500" />
  }
  return <FileText className="w-8 h-8 text-orange-500" />
}

/**
 * Form for configuring asset upload: slug and description fields.
 */
export function AssetUploadForm({
  file,
  channelId,
  apiHost,
  onUpload,
  onCancel,
  onChangeFile,
}: AssetUploadFormProps) {
  const [slug, setSlug] = useState(() => generateSlug(file.name))
  const [tldr, setTldr] = useState('')
  const [slugError, setSlugError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  // Validate slug format
  const validateSlugFormat = useCallback((value: string): string | null => {
    if (!value.trim()) {
      return 'Slug is required'
    }
    // Must have extension
    if (!value.includes('.')) {
      return 'Slug must include file extension (e.g., .png)'
    }
    // Valid characters: lowercase letters, numbers, hyphens, single dot for extension
    if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(value)) {
      return 'Use lowercase letters, numbers, and hyphens only'
    }
    return null
  }, [])

  // Check if slug already exists
  const checkSlugExists = useCallback(async (value: string): Promise<boolean> => {
    try {
      const response = await apiFetch(`${apiHost}/channels/${channelId}/artifacts/${value}`)
      return response.ok // If 200, artifact exists
    } catch {
      return false // Assume doesn't exist on error
    }
  }, [apiHost, channelId])

  // Validate slug on change (with debounce for server check)
  useEffect(() => {
    const formatError = validateSlugFormat(slug)
    if (formatError) {
      setSlugError(formatError)
      return
    }

    // Check server for duplicates
    setIsValidating(true)
    const timer = setTimeout(async () => {
      const exists = await checkSlugExists(slug)
      if (exists) {
        setSlugError('This slug already exists in the channel')
      } else {
        setSlugError(null)
      }
      setIsValidating(false)
    }, 300)

    return () => clearTimeout(timer)
  }, [slug, validateSlugFormat, checkSlugExists])

  // Handle slug input change
  const handleSlugChange = (value: string) => {
    // Sanitize input
    const sanitized = value.toLowerCase().replace(/[^a-z0-9.-]/g, '')
    setSlug(sanitized)
  }

  // Handle form submission
  const handleSubmit = () => {
    if (slugError || isValidating) return
    onUpload(slug, tldr)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium text-base">Upload Asset</span>
        <button
          onClick={onCancel}
          className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Form content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* File info */}
        <div className="flex items-start gap-3 p-3 bg-secondary/30 rounded-lg">
          <FileIcon mimeType={file.type} />
          <div className="flex-1 min-w-0">
            <p className="text-base font-medium truncate">{file.name}</p>
            <p className="text-base text-muted-foreground">
              {formatSize(file.size)}
            </p>
          </div>
          <button
            onClick={onChangeFile}
            className="text-base text-primary hover:underline"
          >
            Change
          </button>
        </div>

        {/* Slug field */}
        <div>
          <label className="block text-base font-medium text-muted-foreground mb-1">
            Slug
          </label>
          <input
            type="text"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            placeholder="e.g., screenshot.png"
            className={cn(
              "w-full px-2 py-1.5 text-base bg-background border rounded focus:outline-none focus:ring-1",
              slugError
                ? "border-destructive focus:ring-destructive"
                : "border-border focus:ring-primary"
            )}
          />
          {slugError && (
            <p className="text-base text-destructive mt-1">{slugError}</p>
          )}
          {isValidating && (
            <p className="text-base text-muted-foreground mt-1">Checking...</p>
          )}
        </div>

        {/* Description field */}
        <div>
          <label className="block text-base font-medium text-muted-foreground mb-1">
            Description <span className="text-muted-foreground/60">(optional)</span>
          </label>
          <textarea
            value={tldr}
            onChange={(e) => setTldr(e.target.value)}
            placeholder="Brief description of this file"
            rows={2}
            className="w-full px-2 py-1.5 text-base bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-border">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-base rounded-md hover:bg-secondary/50 text-muted-foreground"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!!slugError || isValidating || !slug}
          className={cn(
            "px-3 py-1.5 text-base rounded-md font-medium",
            slugError || isValidating || !slug
              ? "bg-secondary text-muted-foreground cursor-not-allowed"
              : "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          Upload
        </button>
      </div>
    </div>
  )
}
