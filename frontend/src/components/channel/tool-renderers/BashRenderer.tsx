/**
 * Bash tool renderer - displays command and output like a terminal.
 */
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useIsDarkMode } from '../../../hooks/useIsDarkMode'
import { cn } from '../../../lib/utils'
import type { ToolRendererProps } from './types'

export function BashRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  const isDarkMode = useIsDarkMode()
  const command = (args.command as string) || ''
  const cwd = (args.cwd as string) || ''

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
      <SyntaxHighlighter
        language="bash"
        style={codeTheme}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: '0.75rem 1rem',
          fontSize: '13px',
          lineHeight: '1.4',
          borderRadius: '0.25rem',
        }}
      >
        {cwd ? `${cwd} $ ${command}` : `$ ${command}`}
      </SyntaxHighlighter>
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
