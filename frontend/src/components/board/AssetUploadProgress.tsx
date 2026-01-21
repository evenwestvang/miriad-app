import { X, Loader2 } from 'lucide-react'

interface AssetUploadProgressProps {
  fileName: string
  progress: number
  onCancel: () => void
}

/**
 * Progress indicator during file upload.
 * Shows file name, progress bar with percentage, and cancel button.
 */
export function AssetUploadProgress({ fileName, progress, onCancel }: AssetUploadProgressProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium text-base flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Uploading...
        </span>
        <button
          onClick={onCancel}
          className="p-1 rounded hover:bg-secondary/50 text-muted-foreground"
          title="Cancel upload"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Progress content */}
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        {/* File name */}
        <p className="text-base font-medium mb-4 text-center truncate max-w-full px-4">
          {fileName}
        </p>

        {/* Progress bar */}
        <div className="w-full max-w-48 mb-2">
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Percentage */}
        <p className="text-base text-muted-foreground">
          {progress}%
        </p>

        {/* Cancel button */}
        <button
          onClick={onCancel}
          className="mt-4 px-3 py-1.5 text-base rounded-md hover:bg-secondary/50 text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
