/**
 * API Client for CAST
 *
 * Simplified client - assumes always authenticated for local development.
 * Auth will be added later via WorkOS.
 */

// API host - use env var or default to local dev server
export const API_HOST = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3233' : '')

/**
 * Check if user is authenticated.
 * For now, always returns true (no auth in MVP).
 */
export async function checkAuth(): Promise<boolean> {
  return true
}

/**
 * Log out - placeholder for future WorkOS integration.
 */
export async function logout(): Promise<void> {
  // No-op for now - will integrate with WorkOS later
  console.log('Logout called - no auth configured yet')
}

/**
 * Fetch wrapper for API calls.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  // Prepend API_HOST if path is relative
  const url = input.startsWith('/') ? `${API_HOST}${input}` : input

  const response = await fetch(url, {
    ...init,
    // No credentials needed for MVP (no auth yet)
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
