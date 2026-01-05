/**
 * API Client with Auth Handling
 *
 * Wraps fetch to intercept 401 responses and trigger auth flow.
 */

// API host - use env var or default to local dev server
export const API_HOST = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '')

// Mock auth login URL - for local dev (prod uses OAuth)
const OAUTH_LOGIN_URL = `${API_HOST}/mock-auth/login`

/**
 * Event name for auth required notifications.
 * App.tsx listens for this to show the landing page.
 */
export const AUTH_REQUIRED_EVENT = 'cikada:auth-required'

/**
 * Dispatch auth required event.
 * This triggers the App to show the landing page.
 */
function dispatchAuthRequired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
}

/**
 * Redirect to OAuth login.
 * Server will handle OAuth flow and redirect back after authentication.
 */
export function redirectToLogin(): void {
  window.location.href = OAUTH_LOGIN_URL
}

/**
 * Log out the current user.
 * Calls backend logout endpoint to clear session cookie, then redirects to login.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_HOST}/mock-auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // Continue with logout even if request fails
  }
  // Dispatch auth required event to update app state
  dispatchAuthRequired()
}

/**
 * Check if user is authenticated by calling a protected endpoint.
 * Returns true if authenticated, false otherwise.
 */
export async function checkAuth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_HOST}/channels`, {
      credentials: 'include',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Fetch wrapper that handles 401 responses.
 * On 401, redirects to OAuth login automatically.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  // Prepend API_HOST if path is relative
  const url = input.startsWith('/') ? `${API_HOST}${input}` : input

  const response = await fetch(url, {
    ...init,
    credentials: 'include', // Always include cookies for auth
  })

  if (response.status === 401) {
    // Dispatch event so App shows landing page
    dispatchAuthRequired()
    throw new AuthError('Authentication required')
  }

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
