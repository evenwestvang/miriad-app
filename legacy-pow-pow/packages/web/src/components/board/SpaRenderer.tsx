import React, { useEffect, useRef, useState } from 'react'
import { Play, Square, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SpaRendererProps {
  content: string
  channel: string
  slug: string
}

interface RuntimeContext {
  width: number
  height: number
  loop: (callback: (dt: number) => void) => () => void
  store: {
    get: (key: string) => any
    set: (key: string, value: any) => void
  }
}

interface AppModule {
  render: (container: HTMLElement, ctx: RuntimeContext) => void
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
  const storageKey = `powpow:spa:${channel}:${slug}`
  const store = {
    get: (key: string) => {
      try {
        const data = localStorage.getItem(`${storageKey}:${key}`)
        return data ? JSON.parse(data) : undefined
      } catch {
        return undefined
      }
    },
    set: (key: string, value: any) => {
      try {
        localStorage.setItem(`${storageKey}:${key}`, JSON.stringify(value))
      } catch {}
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
  }, [dimensions])

  const stopApp = (markStopped = false) => {
    // Stop all animation loops
    loopsRef.current.forEach(id => cancelAnimationFrame(id))
    loopsRef.current.clear()

    // Call app cleanup
    try {
      appRef.current?.cleanup?.()
    } catch {}
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
        app.render(containerRef.current, ctx)
        setRunning(true)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (e: any) {
      setError(e.message || 'Failed to run app')
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Error display */}
      {error && (
        <div className="flex items-center gap-2 p-2 mb-2 rounded bg-destructive/10 text-destructive text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="font-mono flex-1">{error}</span>
          <Button size="sm" variant="ghost" onClick={runApp} className="gap-1 shrink-0">
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      )}

      {/* App container */}
      <div className="flex-1 relative">
        <div
          ref={containerRef}
          className="absolute inset-0 bg-black rounded overflow-hidden"
        />
        {/* Loading state */}
        {!running && !error && !stopped && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm bg-black rounded">
            Loading...
          </div>
        )}
        {/* Stopped state */}
        {stopped && !running && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black rounded">
            <Button size="sm" variant="secondary" onClick={runApp} className="gap-1">
              <Play className="h-3 w-3" />
              Run
            </Button>
          </div>
        )}
      </div>

      {/* Controls - only show when running */}
      {running && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t">
          <Button size="sm" variant="ghost" onClick={() => stopApp(true)} className="gap-1 text-xs">
            <Square className="h-3 w-3" />
            Stop
          </Button>
          <Button size="sm" variant="ghost" onClick={runApp} className="gap-1 text-xs">
            <RefreshCw className="h-3 w-3" />
            Restart
          </Button>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {dimensions.width} × {dimensions.height}
          </span>
        </div>
      )}
    </div>
  )
}
