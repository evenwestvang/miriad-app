export interface RouteState {
  channel: string | null
  agent: string | null
  channelView: 'chat' | 'settings'
  appSettings: boolean
  boardSlug: string | null  // Activity panel: selected artifact
  boardEdit: boolean  // Activity panel: edit mode for artifact
}

export function parseHash(): RouteState {
  const hash = window.location.hash.slice(1) // Remove #
  const state: RouteState = {
    channel: null,
    agent: null,
    channelView: 'chat',
    appSettings: false,
    boardSlug: null,
    boardEdit: false,
  }

  if (!hash) return state

  // Decode fully to handle any encoding
  let decoded = hash
  try {
    // Keep decoding until stable (handles double/triple encoding)
    let prev = ''
    while (decoded !== prev && decoded.includes('%')) {
      prev = decoded
      decoded = decodeURIComponent(decoded)
    }
  } catch {
    // If decoding fails, use as-is
  }

  // Skip if it looks malformed (just slashes)
  if (/^\/+$/.test(decoded)) return state

  // Split on semicolon for activity panel sub-route: #c/channel;board/slug
  const [mainRoute, activityRoute] = decoded.split(';')

  // Parse activity panel route (;board/slug or ;board/slug/edit)
  if (activityRoute) {
    const activityParts = activityRoute.split('/').filter(p => p)
    if (activityParts[0] === 'board' && activityParts[1]) {
      // Check if last part is 'edit'
      if (activityParts[activityParts.length - 1] === 'edit') {
        state.boardEdit = true
        state.boardSlug = activityParts.slice(1, -1).join('/')  // Remove 'edit' from slug
      } else {
        state.boardSlug = activityParts.slice(1).join('/')  // Support slugs with slashes
      }
    }
  }

  const parts = mainRoute.split('/').filter(p => p && p !== '')

  // #settings - show app settings
  if (parts[0] === 'settings') {
    state.appSettings = true
    return state
  }

  // #c/channel-name - channels are prefixed with 'c/'
  if (parts[0] === 'c' && parts[1]) {
    state.channel = parts[1]

    // #c/channel-name/@agent-name
    if (parts[2]?.startsWith('@')) {
      state.agent = parts[2].slice(1)
      return state
    }

    // #c/channel-name/mission
    if (parts[2] === 'mission') state.channelView = 'settings'
  }

  return state
}

export function buildHash(state: RouteState): string {
  if (state.appSettings) {
    return 'settings'
  }

  if (!state.channel) return ''

  let hash = `c/${state.channel}`

  if (state.agent) {
    hash += `/@${state.agent}`
  } else if (state.channelView === 'settings') {
    hash += '/mission'
  }

  // Activity panel sub-route
  if (state.boardSlug) {
    hash += `;board/${state.boardSlug}`
    if (state.boardEdit) {
      hash += '/edit'
    }
  }

  return hash
}
