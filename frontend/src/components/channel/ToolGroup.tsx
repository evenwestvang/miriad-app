import { useState, useEffect } from 'react'
import { ChevronRight, ChevronDown, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Message } from '../../types'
import { getToolRenderer } from './tool-renderers'

interface ToolGroupProps {
  /** Array of consecutive tool_call and tool_result messages */
  messages: Message[]
  /** Whether firehose mode is enabled (expands tool groups by default) */
  firehoseMode?: boolean
}

interface ToolPair {
  call: Message
  result?: Message
}

/**
 * Parse a value that might be a JSON string or already an object.
 * Handles backwards compatibility where some fields are JSON-encoded strings.
 */
function parseJsonOrValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Try to parse as JSON if it looks like JSON
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(value)
      } catch {
        // Not valid JSON, return as-is
        return value
      }
    }
  }
  return value
}

/**
 * Format output for display, handling various formats.
 */
function formatOutput(output: unknown): string {
  if (output === null || output === undefined) {
    return '(empty)'
  }

  const parsed = parseJsonOrValue(output)

  if (typeof parsed === 'string') {
    return parsed || '(empty)'
  }

  return JSON.stringify(parsed, null, 2)
}

/**
 * Groups consecutive tool messages into a collapsible tree view.
 *
 * Collapsed: "▸ 5 tool calls  Read · Grep · Bash"
 * Expanded: Tree list of tool calls, each expandable for details
 */
export function ToolGroup({ messages, firehoseMode = false }: ToolGroupProps) {
  const [expanded, setExpanded] = useState(firehoseMode)

  // Sync expanded state when firehoseMode changes
  useEffect(() => {
    setExpanded(firehoseMode)
  }, [firehoseMode])

  // Pair tool_calls with their corresponding tool_results
  const pairs = pairToolMessages(messages)

  // Count calls and errors
  const callCount = pairs.length
  const errorCount = pairs.filter(p => p.result?.toolResultStatus === 'error').length

  // Get tool names for collapsed preview (deduplicated, max 5)
  const toolNames = getToolNamePreview(pairs)

  // Single tool call - render inline without grouping
  if (callCount === 1) {
    return <SingleToolItem pair={pairs[0]} />
  }

  // Firehose mode - render all tools individually without grouping
  if (firehoseMode) {
    return (
      <>
        {pairs.map((pair) => (
          <div key={pair.call.id} className="my-4">
            <SingleToolItem pair={pair} />
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="my-4">
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-base text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
        )}
        <span>
          {callCount} tool call{callCount !== 1 ? 's' : ''}
          {errorCount > 0 && (
            <span className="text-red-400 ml-1">({errorCount} error{errorCount !== 1 ? 's' : ''})</span>
          )}
        </span>
        {!expanded && (
          <span className="text-xs text-muted-foreground/70 ml-1">
            {toolNames}
          </span>
        )}
      </button>

      {/* Expanded list */}
      {expanded && (
        <div className="mt-1 ml-5">
          {pairs.map((pair, index) => (
            <ToolItem key={pair.call.id} pair={pair} index={index} />
          ))}
        </div>
      )}
    </div>
  )
}

interface ToolItemProps {
  pair: ToolPair
  index: number
}

/**
 * Individual tool call/result in the expanded list.
 * Expandable to show full args and output.
 */
function ToolItem({ pair }: ToolItemProps) {
  const [expanded, setExpanded] = useState(false)

  const toolName = pair.call.toolName || 'Unknown'
  const args = pair.call.toolArgs || {}
  const argsPreview = formatArgsPreview(toolName, args)

  const hasResult = !!pair.result
  const isSuccess = pair.result?.toolResultStatus !== 'error'
  // Try toolResultOutput first, fall back to content field
  const output = pair.result?.toolResultOutput ?? pair.result?.content
  const error = pair.result?.toolResultError

  // Check for custom renderer
  const CustomRenderer = getToolRenderer(toolName)

  return (
    <div className="py-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-base hover:text-foreground transition-colors w-full text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-blue-400 font-medium">{toolName}</span>
        {argsPreview && (
          <span className="text-muted-foreground text-xs font-mono truncate flex-1">{argsPreview}</span>
        )}
        {hasResult && (
          isSuccess ? (
            <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
          ) : (
            <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
          )
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="ml-5 mt-2">
          {CustomRenderer ? (
            <CustomRenderer
              args={args}
              output={output}
              error={error}
              isSuccess={isSuccess}
            />
          ) : (
            <div className="text-xs font-mono text-muted-foreground space-y-2">
              {/* Args */}
              <div>
                <pre className="whitespace-pre-wrap overflow-x-auto">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>

              {/* Result */}
              {hasResult && (
                <div className={cn(
                  "pt-2 border-t border-border/50",
                  !isSuccess && "text-red-400"
                )}>
                  <pre className="whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                    {error || formatOutput(output)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Single tool call rendered without group wrapper.
 * Used when there's only one tool call.
 */
function SingleToolItem({ pair }: { pair: ToolPair }) {
  const [expanded, setExpanded] = useState(false)

  const toolName = pair.call.toolName || 'Unknown'
  const args = pair.call.toolArgs || {}
  const argsPreview = formatArgsPreview(toolName, args)

  const hasResult = !!pair.result
  const isSuccess = pair.result?.toolResultStatus !== 'error'
  // Try toolResultOutput first, fall back to content field
  const output = pair.result?.toolResultOutput ?? pair.result?.content
  const error = pair.result?.toolResultError

  // Check for custom renderer
  const CustomRenderer = getToolRenderer(toolName)

  return (
    <div className="my-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-base hover:text-foreground transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-blue-400 font-medium">{toolName}</span>
        {argsPreview && (
          <span className="text-muted-foreground text-xs font-mono truncate">{argsPreview}</span>
        )}
        {hasResult && (
          isSuccess ? (
            <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
          ) : (
            <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
          )
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="ml-5 mt-2">
          {CustomRenderer ? (
            <CustomRenderer
              args={args}
              output={output}
              error={error}
              isSuccess={isSuccess}
            />
          ) : (
            <div className="text-xs font-mono text-muted-foreground space-y-2">
              {/* Args */}
              <div>
                <pre className="whitespace-pre-wrap overflow-x-auto">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>

              {/* Result */}
              {hasResult && (
                <div className={cn(
                  "pt-2 border-t border-border/50",
                  !isSuccess && "text-red-400"
                )}>
                  <pre className="whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                    {error || formatOutput(output)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Pair tool_call messages with their corresponding tool_result messages.
 * Uses toolCallId/toolResultCallId to match them, or falls back to positional pairing.
 */
function pairToolMessages(messages: Message[]): ToolPair[] {
  const pairs: ToolPair[] = []
  const resultMap = new Map<string, Message>()
  const usedResults = new Set<string>()

  // First pass: collect all results by their call ID
  for (const msg of messages) {
    if (msg.type === 'tool_result' && msg.toolResultCallId) {
      resultMap.set(msg.toolResultCallId, msg)
    }
  }

  // Collect results in order for fallback positional matching
  const resultsInOrder = messages.filter(m => m.type === 'tool_result')
  let resultIndex = 0

  // Second pass: create pairs for each call
  for (const msg of messages) {
    if (msg.type === 'tool_call') {
      const callId = msg.toolCallId || msg.id
      let result = resultMap.get(callId)

      // If no ID match, try positional matching (next unused result)
      if (!result && resultIndex < resultsInOrder.length) {
        result = resultsInOrder[resultIndex]
        resultIndex++
      }

      if (result) {
        usedResults.add(result.id)
      }

      pairs.push({
        call: msg,
        result
      })
    }
  }

  return pairs
}

/**
 * Get preview of tool names for collapsed state.
 * Returns "Read · Grep · Bash" format, max 5 unique names.
 */
function getToolNamePreview(pairs: ToolPair[]): string {
  const names: string[] = []
  const seen = new Set<string>()

  for (const pair of pairs) {
    const name = pair.call.toolName || 'Unknown'
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
      if (names.length >= 5) break
    }
  }

  const suffix = pairs.length > 5 ? ' …' : ''
  return names.join(' · ') + suffix
}

/**
 * Format args preview based on tool type.
 * Shows the most relevant argument for quick scanning.
 */
function formatArgsPreview(toolName: string, args: Record<string, unknown>): string {
  const name = toolName.toLowerCase()

  if (name === 'read_file' || name === 'read') {
    return (args.path as string) || (args.file_path as string) || ''
  }
  if (name === 'write_file' || name === 'write') {
    return (args.path as string) || (args.file_path as string) || ''
  }
  if (name === 'run_bash' || name === 'bash') {
    const cmd = (args.command as string) || ''
    return cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd
  }
  if (name === 'list_files' || name === 'glob') {
    return (args.path as string) || (args.pattern as string) || '.'
  }
  if (name === 'grep') {
    return (args.pattern as string) || ''
  }
  if (name === 'edit') {
    return (args.file_path as string) || ''
  }

  // Default: show first string value
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 60 ? value.slice(0, 60) + '…' : value
    }
  }
  return ''
}
