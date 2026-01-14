/**
 * Write tool renderer - displays file creation/overwriting operations.
 *
 * Shows:
 * - File path with copy button
 * - File size (lines/characters)
 * - Content preview with syntax highlighting
 * - "Created" vs "Overwritten" status
 */
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check } from 'lucide-react'
import { useIsDarkMode } from '../../../hooks/useIsDarkMode'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

const MAX_LINES_PREVIEW = 100 // Show less for Write since user already knows content

/**
 * Detect programming language from file extension.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'py': 'python',
    'rb': 'ruby',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'md': 'markdown',
    'json': 'json',
    'xml': 'xml',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'yaml': 'yaml',
    'yml': 'yaml',
    'sh': 'bash',
    'bash': 'bash',
    'sql': 'sql',
    'graphql': 'graphql',
  }
  return languageMap[ext || ''] || 'text'
}

/**
 * Count lines and characters in text.
 */
function getContentStats(text: string): { lines: number; chars: number } {
  return {
    lines: text.split('\n').length,
    chars: text.length,
  }
}

export function WriteRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const isDarkMode = useIsDarkMode()
  const [copied, setCopied] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const filePath = (args.file_path as string) || (args.path as string) || 'unknown'
  const content = (args.content as string) || ''
  const language = detectLanguage(filePath)
  const stats = getContentStats(content)
  const lines = content.split('\n')

  // Check if file was created or overwritten (heuristic based on output)
  const wasCreated = output && typeof output === 'string' && output.includes('created')

  // Determine if we should show truncation controls
  const shouldTruncate = stats.lines > MAX_LINES_PREVIEW && !showAll
  const displayContent = shouldTruncate
    ? lines.slice(0, MAX_LINES_PREVIEW).join('\n')
    : content

  const codeTheme = isDarkMode ? oneDark : oneLight

  const handleCopy = async () => {
    await navigator.clipboard.writeText(filePath)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-2">
      {/* File path header with copy button */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground">{filePath}</span>
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-muted rounded transition-colors"
          title="Copy file path"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-500" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* Metadata line */}
      <div className="text-xs text-muted-foreground">
        <span className={cn(isSuccess && "text-green-600 dark:text-green-400 font-medium")}>
          {wasCreated ? 'Created' : 'Wrote'}
        </span>
        {' • '}
        <span>{stats.lines} {stats.lines === 1 ? 'line' : 'lines'}</span>
        {' • '}
        <span>{stats.chars.toLocaleString()} characters</span>
      </div>

      {/* Content preview with syntax highlighting */}
      <div className={cn(
        "rounded overflow-hidden",
        !isSuccess && "border border-red-200 dark:border-red-800"
      )}>
        <SyntaxHighlighter
          language={language}
          style={codeTheme}
          showLineNumbers
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: '0.75rem',
            fontSize: '12px',
            lineHeight: '1.5',
            maxHeight: '20rem',
            overflowY: 'auto',
            borderRadius: '0.25rem',
          }}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: isDarkMode ? '#5c6370' : '#9ca3af',
            userSelect: 'none',
          }}
          className={cn(
            !isSuccess && "opacity-60"
          )}
        >
          {displayContent}
        </SyntaxHighlighter>
      </div>

      {/* Show more button for truncated content */}
      {shouldTruncate && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline"
        >
          Show all {stats.lines} lines
        </button>
      )}

      {/* Error message if failed */}
      {!isSuccess && error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}
    </div>
  )
}
