/**
 * URL State Hook
 *
 * Manages hash-based URL routing for channel and sidebar state.
 *
 * URL patterns:
 * - #<channel> - channel selected, board closed
 * - #<channel>;board - channel with board tree view open
 * - #<channel>;board/<slug> - channel with artifact focused
 *
 * Extensible for future sidebar modes.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'

export type SidebarMode = 'closed' | 'board'

export interface UrlState {
  /** Currently selected channel ID */
  channelId: string | null
  /** Sidebar mode */
  sidebarMode: SidebarMode
  /** Currently focused artifact slug (when in board mode) */
  artifactSlug: string | null
}

export interface UseUrlStateReturn {
  /** Current URL state */
  state: UrlState
  /** Navigate to a channel */
  navigateToChannel: (channelId: string) => void
  /** Toggle board visibility */
  toggleBoard: () => void
  /** Open board panel */
  openBoard: () => void
  /** Close board panel */
  closeBoard: () => void
  /** Focus an artifact in the board */
  focusArtifact: (slug: string) => void
  /** Clear artifact focus (stay in board mode) */
  clearArtifactFocus: () => void
  /** Clear all state (go to empty state) */
  clearState: () => void
}

/**
 * Parse URL hash into state
 *
 * Format: #c/<channel>;board/<slug>
 * - #c/<channel> - channel selected, board closed
 * - #c/<channel>;board - channel with board open
 * - #c/<channel>;board/<slug> - channel with artifact focused
 */
function parseHash(hash: string): UrlState {
  // Remove leading #
  const raw = hash.startsWith('#') ? hash.slice(1) : hash

  if (!raw) {
    return { channelId: null, sidebarMode: 'closed', artifactSlug: null }
  }

  // Must start with c/ prefix for channel routes
  if (!raw.startsWith('c/')) {
    return { channelId: null, sidebarMode: 'closed', artifactSlug: null }
  }

  // Remove c/ prefix and split by semicolon
  const withoutPrefix = raw.slice(2)
  const parts = withoutPrefix.split(';')
  const channelId = decodeURIComponent(parts[0]) || null

  if (!channelId) {
    return { channelId: null, sidebarMode: 'closed', artifactSlug: null }
  }

  if (parts.length === 1) {
    // Just channel, no sidebar mode
    return { channelId, sidebarMode: 'closed', artifactSlug: null }
  }

  // Parse sidebar mode (parts[1])
  const modePart = parts[1]

  if (modePart === 'board') {
    return { channelId, sidebarMode: 'board', artifactSlug: null }
  }

  if (modePart.startsWith('board/')) {
    const artifactSlug = decodeURIComponent(modePart.slice(6)) || null
    return { channelId, sidebarMode: 'board', artifactSlug }
  }

  // Unknown mode, default to closed
  return { channelId, sidebarMode: 'closed', artifactSlug: null }
}

/**
 * Serialize state to URL hash
 *
 * Format: #c/<channel>;board/<slug>
 */
function serializeState(state: UrlState): string {
  if (!state.channelId) {
    return ''
  }

  const channelPart = encodeURIComponent(state.channelId)

  if (state.sidebarMode === 'closed') {
    return `#c/${channelPart}`
  }

  if (state.sidebarMode === 'board') {
    if (state.artifactSlug) {
      return `#c/${channelPart};board/${encodeURIComponent(state.artifactSlug)}`
    }
    return `#c/${channelPart};board`
  }

  return `#c/${channelPart}`
}

/**
 * Hook for managing URL-based routing state
 */
export function useUrlState(): UseUrlStateReturn {
  // Initialize state from current URL
  const [state, setState] = useState<UrlState>(() =>
    parseHash(window.location.hash)
  )

  // Update URL when state changes
  const updateUrl = useCallback((newState: UrlState) => {
    const newHash = serializeState(newState)
    const currentHash = window.location.hash || ''

    // Only update if different to avoid duplicate history entries
    // Use replaceState to avoid cluttering browser history
    if (newHash !== currentHash) {
      window.history.replaceState(null, '', newHash || window.location.pathname)
    }

    setState(newState)
  }, [])

  // Listen for browser back/forward navigation and hash changes
  useEffect(() => {
    const handleHashChange = () => {
      setState(parseHash(window.location.hash))
    }

    // hashchange handles both manual URL changes and back/forward
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Navigation functions
  const navigateToChannel = useCallback((channelId: string) => {
    updateUrl({
      channelId,
      sidebarMode: state.sidebarMode, // Preserve current sidebar mode
      artifactSlug: null, // Clear artifact focus on channel change
    })
  }, [state.sidebarMode, updateUrl])

  const toggleBoard = useCallback(() => {
    if (!state.channelId) return

    updateUrl({
      ...state,
      sidebarMode: state.sidebarMode === 'board' ? 'closed' : 'board',
      artifactSlug: null, // Clear artifact focus when toggling
    })
  }, [state, updateUrl])

  const openBoard = useCallback(() => {
    if (!state.channelId) return

    updateUrl({
      ...state,
      sidebarMode: 'board',
    })
  }, [state, updateUrl])

  const closeBoard = useCallback(() => {
    if (!state.channelId) return

    updateUrl({
      ...state,
      sidebarMode: 'closed',
      artifactSlug: null,
    })
  }, [state, updateUrl])

  const focusArtifact = useCallback((slug: string) => {
    if (!state.channelId) return

    updateUrl({
      ...state,
      sidebarMode: 'board',
      artifactSlug: slug,
    })
  }, [state, updateUrl])

  const clearArtifactFocus = useCallback(() => {
    if (!state.channelId) return

    updateUrl({
      ...state,
      artifactSlug: null,
    })
  }, [state, updateUrl])

  const clearState = useCallback(() => {
    updateUrl({
      channelId: null,
      sidebarMode: 'closed',
      artifactSlug: null,
    })
  }, [updateUrl])

  return useMemo(() => ({
    state,
    navigateToChannel,
    toggleBoard,
    openBoard,
    closeBoard,
    focusArtifact,
    clearArtifactFocus,
    clearState,
  }), [
    state,
    navigateToChannel,
    toggleBoard,
    openBoard,
    closeBoard,
    focusArtifact,
    clearArtifactFocus,
    clearState,
  ])
}
