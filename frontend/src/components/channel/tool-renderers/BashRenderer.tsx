/**
 * Bash tool renderer - displays command and output like a terminal.
 * 
 * Shows description as a header when available (great for quick scanning),
 * then the full command with syntax highlighting.
 */
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useIsDarkMode } from '../../../hooks/useIsDarkMode'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'
import { normalizeArgs } from './normalizeArgs'

export function BashRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const isDarkMode = useIsDarkMode()
  const normalized = normalizeArgs(args)
  
  const command = (normalized.command as string) || ''
  const description = (normalized.description as string) || ''
  const cwd = (normalized.cwd as string) || ''

  // Parse output - might be string or object
  let outputText = ''
  if (error) {
    outputText = error
  } else if (typeof output === 'string') {
    outputText = output
  } else if (output && typeof output === 'object' && 'text' in output) {
    outputText = (output as { text: string }).text
  } else if (output) {
    outputText = JSON.stringify(output, null, 2)
  }

  const codeTheme = isDarkMode ? oneDark : oneLight

  return (
    <div className="rounded overflow-hidden">
      {/* Description header when available */}
      {description && (
        <div className={cn(
          "px-3 py-2 text-sm border-b",
          isDarkMode 
            ? "bg-[#21252b] text-[#abb2bf] border-[#181a1f]" 
            : "bg-[#f0f0f0] text-[#383a42] border-[#e0e0e0]"
        )}>
          {description}
        </div>
      )}
      
      {/* Command with syntax highlighting */}
      <SyntaxHighlighter
        language="bash"
        style={codeTheme}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: '0.75rem 1rem',
          fontSize: '13px',
          lineHeight: '1.4',
          borderRadius: description ? '0' : '0.25rem 0.25rem 0 0',
        }}
      >
        {cwd ? `${cwd} $ ${command}` : `$ ${command}`}
      </SyntaxHighlighter>
      
      {/* Output */}
      {outputText && (
        <div
          className={cn(
            "text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto p-3",
            isDarkMode ? "bg-[#282c34] text-[#abb2bf]" : "bg-[#fafafa] text-[#383a42]",
            !isSuccess && "text-red-400"
          )}
        >
          {outputText}
        </div>
      )}
    </div>
  )
}
