import { useState, useCallback, useRef, useEffect } from 'react'
import type { ToolActivity, ToolProgressEvent, SDKCompleteEvent } from '../types'

interface UseToolActivityReturn {
  tools: ToolActivity[]
  isComplete: boolean
  summary: { durationMs: number; numTurns: number } | undefined
  handleToolCall: (toolUseId: string, toolName: string, args?: Record<string, unknown>) => void
  handleToolProgress: (event: ToolProgressEvent) => void
  handleToolComplete: (toolUseId: string, output: string, success: boolean) => void
  handleSDKComplete: (event: SDKCompleteEvent) => void
  toggleExpanded: (toolId: string) => void
  reset: () => void
}

export function useToolActivity(): UseToolActivityReturn {
  const [toolsMap, setToolsMap] = useState<Map<string, ToolActivity>>(new Map())
  const [isComplete, setIsComplete] = useState(true)
  const [summary, setSummary] = useState<{ durationMs: number; numTurns: number } | undefined>()

  // Track local elapsed time for tools without progress events
  const localTimers = useRef<Map<string, { startTime: number; intervalId: number }>>(new Map())

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      localTimers.current.forEach(timer => clearInterval(timer.intervalId))
    }
  }, [])

  // Start local timer for a tool
  const startLocalTimer = useCallback((toolId: string) => {
    const startTime = Date.now()
    const intervalId = window.setInterval(() => {
      setToolsMap(prev => {
        const tool = prev.get(toolId)
        if (tool && tool.status === 'running') {
          const newMap = new Map(prev)
          newMap.set(toolId, {
            ...tool,
            elapsedSeconds: (Date.now() - startTime) / 1000
          })
          return newMap
        }
        return prev
      })
    }, 100) // Update every 100ms for smooth display

    localTimers.current.set(toolId, { startTime, intervalId })
  }, [])

  // Stop local timer for a tool
  const stopLocalTimer = useCallback((toolId: string) => {
    const timer = localTimers.current.get(toolId)
    if (timer) {
      clearInterval(timer.intervalId)
      localTimers.current.delete(toolId)
    }
  }, [])

  // Handle tool_call event - create new tool entry
  const handleToolCall = useCallback((
    toolUseId: string,
    toolName: string,
    args?: Record<string, unknown>
  ) => {
    setIsComplete(false)
    setToolsMap(prev => {
      const newMap = new Map(prev)
      newMap.set(toolUseId, {
        id: toolUseId,
        name: toolName,
        args: args ? formatArgs(toolName, args) : undefined,
        status: 'running',
        elapsedSeconds: 0,
        expanded: false
      })
      return newMap
    })
    startLocalTimer(toolUseId)
  }, [startLocalTimer])

  // Handle tool_progress event - update elapsed time
  const handleToolProgress = useCallback((event: ToolProgressEvent) => {
    setToolsMap(prev => {
      const tool = prev.get(event.toolUseId)
      if (tool) {
        const newMap = new Map(prev)
        newMap.set(event.toolUseId, {
          ...tool,
          elapsedSeconds: event.elapsedSeconds
        })
        return newMap
      }
      // If we get progress without a tool_call, create the entry
      const newMap = new Map(prev)
      newMap.set(event.toolUseId, {
        id: event.toolUseId,
        name: event.toolName,
        status: 'running',
        elapsedSeconds: event.elapsedSeconds,
        expanded: false
      })
      return newMap
    })
  }, [])

  // Handle tool completion
  const handleToolComplete = useCallback((
    toolUseId: string,
    output: string,
    success: boolean
  ) => {
    stopLocalTimer(toolUseId)
    setToolsMap(prev => {
      const tool = prev.get(toolUseId)
      if (tool) {
        const newMap = new Map(prev)
        newMap.set(toolUseId, {
          ...tool,
          status: success ? 'complete' : 'error',
          output: truncateOutput(output)
        })
        return newMap
      }
      return prev
    })
  }, [stopLocalTimer])

  // Handle SDK complete event
  const handleSDKComplete = useCallback((event: SDKCompleteEvent) => {
    // Stop all running timers
    localTimers.current.forEach((_, toolId) => stopLocalTimer(toolId))

    // Mark all running tools as complete
    setToolsMap(prev => {
      const newMap = new Map(prev)
      prev.forEach((tool, id) => {
        if (tool.status === 'running') {
          newMap.set(id, { ...tool, status: 'complete' })
        }
      })
      return newMap
    })

    setIsComplete(true)
    setSummary({
      durationMs: event.durationMs,
      numTurns: event.numTurns
    })
  }, [stopLocalTimer])

  // Toggle expanded state for a tool
  const toggleExpanded = useCallback((toolId: string) => {
    setToolsMap(prev => {
      const tool = prev.get(toolId)
      if (tool) {
        const newMap = new Map(prev)
        newMap.set(toolId, { ...tool, expanded: !tool.expanded })
        return newMap
      }
      return prev
    })
  }, [])

  // Reset for new turn
  const reset = useCallback(() => {
    localTimers.current.forEach((_, toolId) => stopLocalTimer(toolId))
    setToolsMap(new Map())
    setIsComplete(true)
    setSummary(undefined)
  }, [stopLocalTimer])

  // Convert map to array for rendering
  const tools = Array.from(toolsMap.values())

  return {
    tools,
    isComplete,
    summary,
    handleToolCall,
    handleToolProgress,
    handleToolComplete,
    handleSDKComplete,
    toggleExpanded,
    reset
  }
}

// Format tool args for display
function formatArgs(toolName: string, args: Record<string, unknown>): string {
  // Extract the most relevant arg for each tool type
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return (args.file_path as string) || (args.path as string) || ''
    case 'Bash':
      return (args.command as string) || ''
    case 'Grep':
      return (args.pattern as string) || ''
    case 'Glob':
      return (args.pattern as string) || ''
    case 'WebFetch':
    case 'WebSearch':
      return (args.url as string) || (args.query as string) || ''
    case 'Task':
      return (args.description as string) || ''
    default:
      // Return first string value
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && value.length > 0) {
          return value
        }
      }
      return ''
  }
}

// Truncate long output for display
function truncateOutput(output: string, maxLength = 2000): string {
  if (output.length <= maxLength) return output
  return output.slice(0, maxLength) + '\n... (truncated)'
}
