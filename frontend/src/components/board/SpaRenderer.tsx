/**
 * SpaRenderer - Interactive Artifact Runner
 *
 * Renders .app.js artifacts as runnable JavaScript applications.
 * Apps export a default object with render/cleanup functions.
 *
 * Ported from legacy-pow-pow with adaptations for cast-app.
 */
import { useEffect, useRef, useState } from 'react'
import { Play, Square, AlertTriangle, RefreshCw } from 'lucide-react'

interface SpaRendererProps {
  /** JavaScript content of the .app.js artifact */
  content: string
  /** Channel name/ID for storage scoping */
  channel: string
  /** Artifact slug */
  slug: string
}

interface RuntimeContext {
  width: number
  height: number
  loop: (callback: (dt: number) => void) => () => void
  store: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
  }
}

interface AppModule {
  render: (container: HTMLElement, ctx: RuntimeContext) => void | Promise<void>
  cleanup?: () => void
}

export function SpaRenderer({ content, channel, slug }: SpaRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<AppModule | null>(null)
  const loopsRef = useRef<Set<number>>(new Set())
  const [running, setRunning] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const hasAutoRun = useRef(false)

  // Shared runtime context - dimensions updated on resize
  const ctxRef = useRef<RuntimeContext | null>(null)

  // Storage scoped to this artifact
  const storageKey = `cast:spa:${channel}:${slug}`
  const store = {
    get: (key: string): unknown => {
      try {
        const data = localStorage.getItem(`${storageKey}:${key}`)
        return data ? JSON.parse(data) : undefined
      } catch {
        return undefined
      }
    },
    set: (key: string, value: unknown): void => {
      try {
        localStorage.setItem(`${storageKey}:${key}`, JSON.stringify(value))
      } catch {
        // Ignore storage errors
      }
    }
  }

  // Track container dimensions and update ctx
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        const width = Math.floor(entry.contentRect.width)
        const height = Math.floor(entry.contentRect.height)
        setDimensions({ width, height })
        // Update live ctx so running apps see new dimensions
        if (ctxRef.current) {
          ctxRef.current.width = width
          ctxRef.current.height = height
        }
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // Cleanup on unmount or content change
  useEffect(() => {
    return () => {
      stopApp()
      hasAutoRun.current = false
    }
  }, [content])

  // Auto-run when dimensions are ready
  useEffect(() => {
    if (dimensions.width > 0 && dimensions.height > 0 && !hasAutoRun.current && !running) {
      hasAutoRun.current = true
      runApp()
    }
  }, [dimensions, running])

  const stopApp = (markStopped = false) => {
    // Stop all animation loops
    loopsRef.current.forEach(id => cancelAnimationFrame(id))
    loopsRef.current.clear()

    // Call app cleanup
    try {
      appRef.current?.cleanup?.()
    } catch {
      // Ignore cleanup errors
    }
    appRef.current = null
    ctxRef.current = null

    // Clear container
    if (containerRef.current) {
      containerRef.current.innerHTML = ''
    }

    setRunning(false)
    if (markStopped) setStopped(true)
  }

  const runApp = async () => {
    if (!containerRef.current) return

    setError(null)
    setStopped(false)
    stopApp()

    try {
      // Create runtime context - width/height are mutable, updated on resize
      const ctx: RuntimeContext = {
        width: dimensions.width,
        height: dimensions.height,
        loop: (callback: (dt: number) => void) => {
          let lastTime = performance.now()
          let rafId: number

          const tick = (now: number) => {
            const dt = now - lastTime
            lastTime = now
            try {
              callback(dt)
            } catch (e) {
              console.error('App loop error:', e)
            }
            rafId = requestAnimationFrame(tick)
            loopsRef.current.add(rafId)
          }

          rafId = requestAnimationFrame(tick)
          loopsRef.current.add(rafId)

          return () => {
            cancelAnimationFrame(rafId)
            loopsRef.current.delete(rafId)
          }
        },
        store
      }

      // Create blob URL and import the module
      const blob = new Blob([content], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)

      try {
        const module = await import(/* @vite-ignore */ url)
        const app: AppModule = module.default

        if (typeof app?.render !== 'function') {
          throw new Error('App must export default { render(container, ctx) { ... } }')
        }

        appRef.current = app
        ctxRef.current = ctx
        await app.render(containerRef.current, ctx)
        setRunning(true)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to run app'
      setError(message)
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[200px]">
      {/* Error display */}
      {error && (
        <div className="flex items-center gap-2 p-2 mb-2 rounded bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="font-mono flex-1 break-all">{error}</span>
          <button
            onClick={runApp}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-red-200 dark:hover:bg-red-800/30 shrink-0"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      {/* App container */}
      <div className="flex-1 relative min-h-[160px]">
        <div
          ref={containerRef}
          className="absolute inset-0 bg-black rounded overflow-hidden"
        />
        {/* Loading state */}
        {!running && !error && !stopped && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm bg-black rounded">
            Loading...
          </div>
        )}
        {/* Stopped state */}
        {stopped && !running && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black rounded">
            <button
              onClick={runApp}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm"
            >
              <Play className="h-3 w-3" />
              Run
            </button>
          </div>
        )}
      </div>

      {/* Controls - only show when running */}
      {running && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border">
          <button
            onClick={() => stopApp(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
          <button
            onClick={runApp}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
            Restart
          </button>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {dimensions.width} × {dimensions.height}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Check if an artifact slug represents an interactive app
 */
export function isSpaArtifact(slug: string | undefined): boolean {
  return slug?.endsWith('.app.js') ?? false
}
