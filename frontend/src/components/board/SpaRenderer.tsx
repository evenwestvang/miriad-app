/**
 * SpaRenderer - Interactive Artifact Runner
 *
 * Renders .app.js artifacts as runnable JavaScript applications.
 * Apps export a default object with render/cleanup functions.
 *
 * Ported from legacy-pow-pow with adaptations for cast-app.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Square, AlertTriangle, RefreshCw, Maximize2, X } from 'lucide-react'
import { createPortal } from 'react-dom'

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
  const inlineContainerRef = useRef<HTMLDivElement>(null)
  const fullscreenContainerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<AppModule | null>(null)
  const loopsRef = useRef<Set<number>>(new Set())
  const [running, setRunning] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const hasAutoRun = useRef(false)

  // Get the active container based on fullscreen state
  const containerRef = isFullscreen ? fullscreenContainerRef : inlineContainerRef

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

  // Track active container dimensions
  // Single observer that watches whichever container is currently active
  useEffect(() => {
    let observer: ResizeObserver | null = null
    let cancelled = false

    const setup = () => {
      if (cancelled) return
      const container = isFullscreen ? fullscreenContainerRef.current : inlineContainerRef.current
      if (!container) return

      const updateDimensions = () => {
        const rect = container.getBoundingClientRect()
        const width = Math.floor(rect.width)
        const height = Math.floor(rect.height)
        if (width > 0 && height > 0) {
          setDimensions({ width, height })
          // Update live ctx so running apps see new dimensions
          if (ctxRef.current) {
            ctxRef.current.width = width
            ctxRef.current.height = height
          }
        }
      }

      observer = new ResizeObserver(updateDimensions)
      observer.observe(container)

      // Initial update
      updateDimensions()
    }

    // Small delay for fullscreen to ensure portal is mounted
    if (isFullscreen) {
      const timer = setTimeout(setup, 50)
      return () => {
        cancelled = true
        clearTimeout(timer)
        observer?.disconnect()
      }
    } else {
      setup()
      return () => {
        cancelled = true
        observer?.disconnect()
      }
    }
  }, [isFullscreen])

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
  }, [dimensions])

  // ESC key exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setIsFullscreen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isFullscreen])

  // Restart app when toggling fullscreen (to render in new container)
  useEffect(() => {
    if (running && containerRef.current) {
      // Small delay to ensure the new container is mounted
      const timer = setTimeout(() => {
        runApp()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isFullscreen])

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev)
  }, [])

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
    const container = containerRef.current
    if (!container) return

    setError(null)
    setStopped(false)
    stopApp()

    try {
      // Get current container dimensions (more reliable than state for fullscreen transitions)
      const rect = container.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)

      // Update state to keep UI in sync
      setDimensions({ width, height })

      // Create runtime context - width/height are mutable, updated on resize
      const ctx: RuntimeContext = {
        width,
        height,
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
        await app.render(container, ctx)
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
    <div className="flex flex-col flex-1 min-h-0 p-2">
      {/* Error display */}
      {error && (
        <div className="flex items-center gap-2 p-2 mb-2 rounded bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-base">
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
      <div className="flex-1 relative min-h-0">
        <div
          ref={inlineContainerRef}
          className="absolute inset-0 bg-black rounded overflow-hidden"
        />
        {/* Loading state */}
        {!running && !error && !stopped && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-base bg-black rounded">
            Loading...
          </div>
        )}
        {/* Stopped state */}
        {stopped && !running && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black rounded">
            <button
              onClick={runApp}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-base"
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
            className="flex items-center gap-1 px-2 py-1 rounded text-base hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
          <button
            onClick={runApp}
            className="flex items-center gap-1 px-2 py-1 rounded text-base hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
            Restart
          </button>
          <span className="text-base text-muted-foreground ml-auto">
            {dimensions.width} × {dimensions.height}
          </span>
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 px-2 py-1 rounded text-base hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
            title="Expand (ESC to close)"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Fullscreen overlay */}
      {isFullscreen && createPortal(
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          {/* Fullscreen app container */}
          <div className="flex-1 relative">
            <div
              ref={fullscreenContainerRef}
              className="absolute inset-0 bg-black"
            />
          </div>
          {/* Minimal controls in fullscreen */}
          <div className="flex items-center justify-center gap-4 p-3 bg-gray-900/80">
            <button
              onClick={() => stopApp(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-base hover:bg-gray-700 text-gray-300 hover:text-white"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
            <button
              onClick={runApp}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-base hover:bg-gray-700 text-gray-300 hover:text-white"
            >
              <RefreshCw className="h-4 w-4" />
              Restart
            </button>
            <span className="text-base text-gray-500 flex-1 text-center">
              {dimensions.width} × {dimensions.height}
            </span>
            {/* Close button */}
            <button
              onClick={() => setIsFullscreen(false)}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-base hover:bg-gray-700 text-gray-300 hover:text-white"
              title="Close (ESC)"
            >
              <X className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>,
        document.body
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
