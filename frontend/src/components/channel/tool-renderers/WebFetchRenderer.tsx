/**
 * WebFetch renderer - displays web content retrieval and processing.
 *
 * Shows:
 * - Full URL with copy button
 * - Prompt used to process content
 * - Response summary
 * - Response length indicator
 */
import { useState } from 'react'
import { Globe, Copy, Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

export function WebFetchRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const [copied, setCopied] = useState(false)

  const url = (args.url as string) || ''
  const prompt = (args.prompt as string) || ''

  // Parse output
  let responseText = ''
  if (typeof output === 'string') {
    responseText = output
  } else if (output && typeof output === 'object' && 'text' in output) {
    responseText = (output as { text: string }).text
  } else if (output) {
    responseText = JSON.stringify(output, null, 2)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Globe className="w-4 h-4" />
        <span className="text-xs font-medium text-primary">WebFetch</span>
      </div>

      {/* URL with copy button */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground truncate">
          {url}
        </span>
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-muted transition-colors flex-shrink-0"
          title="Copy URL"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-500" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* Prompt if provided */}
      {prompt && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Prompt:</span> {prompt}
        </div>
      )}

      {/* Response length */}
      {responseText && (
        <div className="text-xs text-muted-foreground">
          Response: {responseText.length.toLocaleString()} characters
        </div>
      )}

      {/* Response preview */}
      {responseText && (
        <div className={cn(
          "text-xs bg-muted/50 p-2 border border-border max-h-48 overflow-y-auto",
          !isSuccess && "opacity-60"
        )}>
          <div className="text-muted-foreground whitespace-pre-wrap">
            {responseText.slice(0, 500)}
            {responseText.length > 500 && '\n...'}
          </div>
        </div>
      )}

      {/* Error message if failed */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2">
          {error}
        </div>
      )}
    </div>
  )
}
