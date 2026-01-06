/**
 * API Client for CAST
 *
 * Simplified client - assumes always authenticated for local development.
 * Auth will be added later via WorkOS.
 */

// API host - use env var or default to local dev server (port 3234 to avoid conflicts)
// This is the single source of truth for backend URL - all HTTP and WebSocket calls should use this
export const API_HOST = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3234'

// =============================================================================
// Auth Types
// =============================================================================

export interface StoredUser {
  id: string
  externalId: string
  callsign: string
  email?: string
  avatarUrl?: string
  createdAt: string
  updatedAt: string
}

export interface StoredSpace {
  id: string
  name: string
  ownerId: string
  createdAt: string
  updatedAt: string
}

export interface AuthSession {
  userId: string
  spaceId: string
  user: StoredUser
  space: StoredSpace
}

export interface SpaceWithOwner {
  space: StoredSpace
  owner: StoredUser
}

// =============================================================================
// Auth Functions
// =============================================================================

/**
 * Check if user is authenticated.
 * Calls /auth/me endpoint and returns session info if authenticated.
 */
export async function checkAuth(): Promise<AuthSession | null> {
  try {
    const response = await fetch(`${API_HOST}/auth/me`, {
      credentials: 'include',
    })
    if (response.status === 401) {
      return null
    }
    if (!response.ok) {
      console.error('Auth check failed:', response.status)
      return null
    }
    return response.json()
  } catch (error) {
    console.error('Auth check error:', error)
    return null
  }
}

/**
 * Fetch available spaces for dev mode login.
 */
export async function fetchDevSpaces(): Promise<SpaceWithOwner[]> {
  const response = await fetch(`${API_HOST}/auth/dev/spaces`, {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch spaces: ${response.status}`)
  }
  const data = await response.json()
  return data.spaces || []
}

/**
 * Dev mode login - either login to existing space or create new user+space.
 */
export async function devLogin(params: {
  spaceId?: string
  callsign?: string
  spaceName?: string
}): Promise<{ userId: string; spaceId: string }> {
  const response = await fetch(`${API_HOST}/auth/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Login failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Log out - clears session cookie.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_HOST}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch (error) {
    console.error('Logout error:', error)
  }
  // Reload page to reset state
  window.location.reload()
}

/**
 * Complete onboarding for new WorkOS users.
 * Called after OAuth when user needs to pick callsign and space name.
 */
export async function completeOnboarding(params: {
  callsign: string
  spaceName: string
  onboardingToken: string
}): Promise<{ userId: string; spaceId: string }> {
  const response = await fetch(`${API_HOST}/auth/complete-onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Onboarding failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Fetch wrapper for API calls.
 * Includes credentials for session cookie authentication.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  // Prepend API_HOST if path is relative
  const url = input.startsWith('/') ? `${API_HOST}${input}` : input

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
  })

  return response
}

/**
 * Custom error class for auth failures.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Helper for JSON API calls.
 */
export async function apiJson<T>(
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await apiFetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `API error: ${response.status}`)
  }

  return response.json()
}

/**
 * POST JSON helper.
 */
export async function apiPost<T>(
  input: string,
  body: unknown
): Promise<T> {
  return apiJson<T>(input, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE helper.
 */
export async function apiDelete(input: string): Promise<void> {
  const response = await apiFetch(input, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `API error: ${response.status}`)
  }
}

// =============================================================================
// Backend/Engine Types
// =============================================================================

export interface BackendCapabilities {
  supportsMcp: boolean
  supportsTools: boolean
  supportsVision: boolean
}

export interface BackendInfo {
  name: string
  isBuiltIn: boolean
  capabilities: BackendCapabilities
}

/**
 * Fetch available backends/engines from the API.
 */
export async function fetchBackends(): Promise<BackendInfo[]> {
  const response = await apiFetch('/api/backends')
  if (!response.ok) {
    throw new Error('Failed to fetch backends')
  }
  return response.json()
}
