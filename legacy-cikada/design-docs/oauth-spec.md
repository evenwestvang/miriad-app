# OAuth 2.1 Specification

## Overview

Cikada implements OAuth 2.1 with PKCE for MCP server authentication. This allows agents to access OAuth-protected external MCP servers (e.g., GitHub MCP, Linear MCP) on behalf of users.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  User/Browser   │────▶│  Cikada Server  │────▶│  MCP Server     │
│                 │     │  (OAuth Client) │     │  (OAuth Server) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │  1. Click Connect     │                       │
        │─────────────────────▶│                       │
        │                       │  2. Discover metadata │
        │                       │──────────────────────▶│
        │                       │                       │
        │                       │  3. Register client   │
        │                       │──────────────────────▶│
        │                       │                       │
        │  4. Redirect to auth  │                       │
        │◀─────────────────────│                       │
        │                       │                       │
        │  5. User authorizes   │                       │
        │──────────────────────────────────────────────▶│
        │                       │                       │
        │  6. Callback + code   │                       │
        │─────────────────────▶│                       │
        │                       │  7. Exchange code     │
        │                       │──────────────────────▶│
        │                       │                       │
        │                       │  8. Token stored      │
        │                       │                       │
        │  9. Agent uses token  │                       │
        │                       │──────────────────────▶│
```

## Components

### PKCE (`pkce.ts`)

OAuth 2.1 requires PKCE (Proof Key for Code Exchange) for all authorization code flows:

```typescript
// Generate PKCE pair
const pkce = generatePKCE();
// Returns:
// {
//   codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
//   codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
//   codeChallengeMethod: "S256"
// }
```

- `code_verifier`: Random 43-128 character string
- `code_challenge`: SHA256 hash of verifier, base64url encoded
- `code_challenge_method`: Always "S256" (required by OAuth 2.1)

### Discovery (`discovery.ts`)

Implements RFC 8414 OAuth Authorization Server Metadata Discovery:

```typescript
// Discover OAuth endpoints for an MCP server
const metadata = await discoverOAuthMetadata("https://mcp.github.com");
// Checks /.well-known/oauth-authorization-server
// Falls back to default /authorize and /token paths
```

**Metadata fields:**
- `authorization_endpoint` - User authorization URL
- `token_endpoint` - Token exchange URL
- `registration_endpoint` - Dynamic client registration (RFC 7591)
- `scopes_supported` - Available OAuth scopes
- `code_challenge_methods_supported` - PKCE methods

### Client Registration (`registration.ts`)

Supports RFC 7591 Dynamic Client Registration:

```typescript
const client = await getOrRegisterClient(
  channelId,
  mcpSlug,
  "https://mcp.github.com",
  "https://cikada.app/api/oauth/callback"
);
// Returns: { clientId, clientSecret? }
```

If the MCP server supports dynamic registration:
1. Cikada registers itself as a client
2. Receives `client_id` and optional `client_secret`
3. Stores registration for future use

If registration not supported:
- Falls back to default client ID "cikada"
- Some MCP servers pre-configure this client

### Authorization Flow (`flow.ts`)

Manages the OAuth authorization code flow:

```typescript
// 1. Start OAuth flow
const { authorizationUrl, state } = await startOAuthFlow({
  mcpSlug: "github-mcp",
  channel: "dev-team",
  mcpUrl: "https://mcp.github.com",
  baseUrl: "https://cikada.app"
});
// User redirects to authorizationUrl

// 2. Handle callback
const { code, pendingState } = validateCallback({
  code: "auth_code_from_callback",
  state: "state_from_callback"
});
```

**Pending state management:**
- Random state parameter for CSRF protection
- Stores code_verifier for token exchange
- 10-minute TTL with automatic cleanup
- One-time use (deleted after validation)

### Token Exchange (`tokens.ts`)

Exchanges authorization code for access/refresh tokens:

```typescript
const tokens = await exchangeCodeForTokens({
  tokenEndpoint: "https://mcp.github.com/token",
  code: "authorization_code",
  codeVerifier: "pkce_verifier",
  redirectUri: "https://cikada.app/api/oauth/callback",
  clientId: "cikada"
});
// Returns:
// {
//   access_token: "...",
//   token_type: "Bearer",
//   expires_in: 3600,
//   refresh_token: "..."
// }
```

**Token refresh:**
```typescript
const newTokens = await refreshAccessToken({
  tokenEndpoint: "https://mcp.github.com/token",
  refreshToken: "existing_refresh_token",
  clientId: "cikada"
});
```

### Token Storage (`storage.ts`)

Persists tokens per-channel per-MCP-server:

```typescript
// Save token
await saveToken(channelId, mcpSlug, {
  accessToken: "...",
  refreshToken: "...",
  expiresAt: Date.now() + 3600000,
  scope: "repo read:user"
});

// Get token (returns undefined if expired)
const token = await getStoredToken(channelId, mcpSlug);

// Check status
const status = await getTokenStatus(channelId, mcpSlug);
// Returns: "connected" | "expired" | "disconnected"
```

**Storage location:** `~/.cikada/oauth-tokens/{channelId}/{mcpSlug}.json`

### API Endpoints (`api.ts`)

HTTP API for OAuth operations:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/oauth/status` | GET | Get token status for channel |
| `/api/oauth/start` | POST | Start OAuth flow |
| `/api/oauth/callback` | GET | Handle OAuth callback |
| `/api/oauth/disconnect` | POST | Revoke and delete token |

### Integration (`integration.ts`)

Integrates OAuth with agent MCP connections:

```typescript
// Get valid token, auto-refreshing if needed
const token = await getValidOAuthToken(channelId, mcpSlug, mcpUrl);

// Resolve MCP configs with auth headers
const configs = await resolveMcpConfigsWithOAuth(channelId, mcpConfigs);
// Adds Authorization header to configs with valid tokens
```

## Frontend Integration

### OAuthConnectButton Component

The frontend provides a "Connect" button for OAuth-protected MCP servers:

1. Checks token status via `/api/oauth/status`
2. Shows "Connect", "Connected", or "Reconnect" based on status
3. On click, opens authorization URL in popup/new tab
4. Polls for completion and updates UI

### system.mcp Artifact Props

MCP servers with OAuth have auth config in props:

```json
{
  "type": "system.mcp",
  "slug": "github-mcp",
  "props": {
    "url": "https://mcp.github.com",
    "auth": {
      "type": "oauth",
      "scopes": ["repo", "read:user"],
      "clientId": "optional-pre-configured-client-id"
    }
  }
}
```

## Security

1. **PKCE Required** - All flows use S256 code challenge
2. **State Parameter** - CSRF protection on callbacks
3. **Short-Lived States** - 10-minute TTL for pending authorizations
4. **Secure Storage** - Tokens stored in protected directory
5. **Token Refresh** - Automatic refresh before expiry
6. **No Plaintext Secrets** - Code verifier never sent in URL

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `access_denied` | User denied authorization | Re-prompt user |
| `invalid_state` | CSRF or expired state | Restart flow |
| `invalid_grant` | Code expired or reused | Restart flow |
| `invalid_client` | Registration issue | Re-register |
| `server_error` | MCP server error | Retry later |

## Implementation Status

| Feature | Status |
|---------|--------|
| PKCE generation | ✅ Complete |
| Metadata discovery | ✅ Complete |
| Dynamic registration | ✅ Complete |
| Authorization flow | ✅ Complete |
| Token exchange | ✅ Complete |
| Token refresh | ✅ Complete |
| Token storage | ✅ Complete |
| API endpoints | ✅ Complete |
| Frontend button | ✅ Complete |
| Agent integration | ✅ Complete |
