/**
 * App Integration API
 *
 * Handles communication with app integration endpoints for system.app artifacts.
 * Connection status is derived from artifact secrets metadata.
 */

import { apiFetch, apiJson, API_HOST } from './api'

// =============================================================================
// Types
// =============================================================================

/** App definition from the registry */
export interface AppDefinition {
  id: string
  name: string
  description: string
  icon?: string
  scopes: string[]
}

/** Secret metadata (values are never exposed) */
export interface SecretMetadata {
  setAt: string
  expiresAt?: string
}

/** Secrets metadata on an artifact */
export type SecretsMetadata = Record<string, SecretMetadata>

/** Connection status derived from secrets */
export type AppConnectionStatus = 'not_connected' | 'connected' | 'expired'

/** OAuth start response */
export interface OAuthStartResponse {
  authorizationUrl: string
}

// =============================================================================
// Status Derivation
// =============================================================================

/**
 * Derive connection status from artifact secrets metadata.
 *
 * - No accessToken secret → not_connected
 * - accessToken exists and not expired → connected
 * - accessToken.expiresAt is in the past → expired
 */
export function deriveAppStatus(secrets?: SecretsMetadata): AppConnectionStatus {
  if (!secrets?.accessToken) {
    return 'not_connected'
  }

  const { expiresAt } = secrets.accessToken
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return 'expired'
  }

  return 'connected'
}

/**
 * Check if token is expiring soon (within 24 hours).
 */
export function isExpiringSoon(secrets?: SecretsMetadata): boolean {
  if (!secrets?.accessToken?.expiresAt) {
    return false
  }

  const expiresAt = new Date(secrets.accessToken.expiresAt)
  const now = new Date()
  const hoursUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60)

  return hoursUntilExpiry > 0 && hoursUntilExpiry < 24
}

// =============================================================================
// Validation
// =============================================================================

/** Allowed characters for provider IDs (defense in depth against path traversal) */
const PROVIDER_ID_REGEX = /^[a-z0-9-]+$/

/**
 * Validate provider ID is safe to use in URL paths.
 * Throws if provider contains unsafe characters.
 */
function validateProviderId(provider: string): void {
  if (!PROVIDER_ID_REGEX.test(provider)) {
    throw new Error(`Invalid provider ID: ${provider}`)
  }
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Fetch available apps from the registry.
 * GET /auth/apps → { apps: AppDefinition[] }
 */
export async function fetchAvailableApps(): Promise<AppDefinition[]> {
  const response = await apiJson<{ apps: AppDefinition[] }>('/auth/apps')
  return response.apps
}

/**
 * Initiate OAuth connect flow.
 * GET /auth/apps/:provider/connect
 *
 * Returns authorization URL to redirect user to.
 */
export async function startAppConnect(
  provider: string,
  params: {
    spaceId: string
    channelId: string
    slug: string
  }
): Promise<OAuthStartResponse> {
  validateProviderId(provider)

  const searchParams = new URLSearchParams({
    spaceId: params.spaceId,
    channelId: params.channelId,
    slug: params.slug,
    returnOrigin: window.location.origin,
  })

  const response = await apiFetch(
    `${API_HOST}/auth/apps/${provider}/connect?${searchParams}`
  )

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `Failed to start OAuth: ${response.status}`)
  }

  return response.json()
}

/**
 * Disconnect an app (clear tokens).
 * POST /auth/apps/:provider/disconnect
 */
export async function disconnectApp(
  provider: string,
  params: {
    spaceId: string
    channelId: string
    slug: string
  }
): Promise<void> {
  validateProviderId(provider)

  const response = await apiFetch(`${API_HOST}/auth/apps/${provider}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `Failed to disconnect: ${response.status}`)
  }
}

/**
 * Refresh an expired token.
 * POST /auth/apps/:provider/refresh
 */
export async function refreshAppToken(
  provider: string,
  params: {
    spaceId: string
    channelId: string
    slug: string
  }
): Promise<void> {
  validateProviderId(provider)

  const response = await apiFetch(`${API_HOST}/auth/apps/${provider}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `Failed to refresh token: ${response.status}`)
  }
}

// =============================================================================
// OAuth Callback Handling
// =============================================================================

/** Message sent from OAuth callback popup */
export interface OAuthCallbackMessage {
  type: 'oauth-app-callback'
  success: boolean
  provider: string
  slug: string
  error?: string
  errorDescription?: string
}

/**
 * Check if a MessageEvent contains an OAuth app callback.
 */
export function isOAuthAppCallback(event: MessageEvent): event is MessageEvent<OAuthCallbackMessage> {
  return event.data?.type === 'oauth-app-callback'
}
