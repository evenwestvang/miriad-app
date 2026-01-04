# Agent Authentication Specification

This document specifies how containerized agents (sandbox/Fargate) authenticate when calling back to the Cikada backend. For user authentication (mock auth for dev, WorkOS for production), see the separate user auth documentation.

---

## 1. Overview

Agents running in containers need to authenticate when making API calls back to the Cikada server. The system uses **container tokens** — signed credentials that identify the agent's space, channel, and callsign.

**Key Principle**: Container tokens are scoped to a specific (spaceId, channelId, callsign) tuple. An agent can only access resources within its assigned space and channel.

---

## 2. Container Token Format

**Source**: `packages/server/src/auth/container-token.ts`

### 2.1 Token Structure

```
<base64url-encoded-payload>.<hmac-signature>
```

**Payload format** (before encoding):
```
{spaceId}:{channelId}:{callsign}
```

**Example**:
```
c3BhY2UtMTIzOmNoYW5uZWwtNDU2OmFsZmE.8kL2mN9pQ3rS5tU7vW9xY1zA3bC5dE7fG9hI1jK3lM
```

### 2.2 Token Generation

```typescript
// packages/server/src/auth/container-token.ts:36-40, 52-57

export interface ContainerTokenPayload {
  spaceId: string;
  channelId: string;
  callsign: string;
}

export function generateContainerToken(payload: ContainerTokenPayload): string {
  const data = `${payload.spaceId}:${payload.channelId}:${payload.callsign}`;
  const encodedData = Buffer.from(data).toString('base64url');
  const hmac = createHmac('sha256', CONTAINER_SECRET)
    .update(data)
    .digest('base64url');
  return `${encodedData}.${hmac}`;
}
```

### 2.3 Token Verification

```typescript
// packages/server/src/auth/container-token.ts:65-98

export function verifyContainerToken(token: string): ContainerTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedData, providedHmac] = parts;
  const data = Buffer.from(encodedData, 'base64url').toString();
  
  // Verify HMAC
  const expectedHmac = createHmac('sha256', CONTAINER_SECRET)
    .update(data)
    .digest('base64url');
  
  if (providedHmac !== expectedHmac) return null;

  // Parse payload
  const [spaceId, channelId, callsign] = data.split(':');
  if (!spaceId || !channelId || !callsign) return null;

  return { spaceId, channelId, callsign };
}
```

### 2.4 Secret Management

The HMAC key is sourced from the `CIKADA_CONTAINER_SECRET` environment variable, with a fallback for local development:

```typescript
// packages/server/src/auth/container-token.ts:19-25

const DEV_SECRET = 'dev-container-secret-do-not-use-in-production';
const CONTAINER_SECRET = process.env.CIKADA_CONTAINER_SECRET ?? DEV_SECRET;

if (!process.env.CIKADA_CONTAINER_SECRET) {
  console.warn('[container-token] Using DEV_SECRET - do not use in production');
}
```

**Note**: In local development, a hardcoded `DEV_SECRET` is used when `CIKADA_CONTAINER_SECRET` is not set. This simplifies local setup but **must never be used in production**.

**Security Requirements**:
- Must be set on both the server and anywhere tokens are generated
- Should be a cryptographically random string (minimum 32 bytes recommended)
- Must be kept secret — never logged or exposed

---

## 3. Token Lifecycle

### 3.1 Generation (Agent Spawn)

When an agent is spawned, the server generates a container token:

**Source**: `packages/server/src/agent-manager.ts:661,888`

```typescript
const authToken = generateContainerToken({
  spaceId,
  channelId,
  callsign,
});
```

### 3.2 Delivery to Container

The token is passed to containers via the `CIKADA_AUTH_TOKEN` environment variable:

**Source**: `packages/local-runtime/src/sandbox/docker-orchestrator.ts:189-195`

```typescript
const env = {
  CIKADA_AUTH_TOKEN: config.authToken,
  CIKADA_API_URL: config.apiUrl,
  CIKADA_CHANNEL_ID: config.channelId,
  CIKADA_CALLSIGN: config.callsign,
  // ... other env vars
};
```

### 3.3 Usage in API Calls

Containers include the token in the `X-Cikada-Token` header:

**Source**: `packages/fargate-runtime/wrapper/mcp-artifact-server.ts:29-32`

```typescript
const CIKADA_AUTH_TOKEN = process.env.CIKADA_AUTH_TOKEN ?? "";

// In fetch calls:
const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (CIKADA_AUTH_TOKEN) {
  headers["X-Cikada-Token"] = CIKADA_AUTH_TOKEN;
}
```

---

## 4. Auth Middleware

The server uses a dual authentication mechanism supporting both user sessions and container tokens.

**Source**: `packages/server/src/auth/middleware.ts`

### 4.1 Token-Based Auth (Containers)

```typescript
// packages/server/src/auth/middleware.ts:76-160

export function requireAuth(handler: AuthenticatedHandler) {
  return async (req: Request, res: Response) => {
    // Check for container token first (X-Cikada-Token header)
    const containerToken = req.headers['x-cikada-token'] as string | undefined;
    if (containerToken) {
      const tokenPayload = verifyContainerToken(containerToken);
      if (tokenPayload) {
        (req as AuthenticatedRequest).userId = `agent:${tokenPayload.callsign}`;
        (req as AuthenticatedRequest).spaceId = tokenPayload.spaceId;
        (req as AuthenticatedRequest).channelId = tokenPayload.channelId;
        (req as AuthenticatedRequest).callsign = tokenPayload.callsign;
        return handler(req, res);
      }
    }
    
    // Fall back to session-based auth...
  };
}
```

### 4.2 AuthenticatedRequest Shape

```typescript
export interface AuthenticatedRequest extends Request {
  userId: string;           // "agent:{callsign}" for containers, user ID for sessions
  spaceId: string;          // Space the request is scoped to
  channelId?: string;       // Only set for container tokens
  callsign?: string;        // Only set for container tokens
}
```

### 4.3 Auth Priority

1. **Container token** (`X-Cikada-Token` header) — checked first
2. **Session cookie** — fallback for browser-based requests

If neither is valid, returns 401 Unauthorized.

---

## 5. Scope and Permissions

Container tokens enforce strict scoping:

| Field | Purpose | Enforcement |
|-------|---------|-------------|
| `spaceId` | Multi-tenant isolation | All storage queries use this spaceId |
| `channelId` | Channel-scoped access | Token only valid for this channel |
| `callsign` | Agent identity | Used for attribution, roster lookups |

**Implications**:
- An agent cannot access channels outside its assigned channelId
- An agent cannot impersonate other agents
- Cross-channel communication requires routing through the message system

---

## 6. WebSocket Authentication

WebSocket connections (`/channels/:channelId/stream`) also support container tokens but currently only use session-based auth:

**Source**: `packages/server/src/websocket.ts:83-96`

```typescript
async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  let spaceId = 'default';

  if (authEnabled) {
    const session = await verifySession(req);
    if (!session) {
      ws.close(4001, 'Unauthorized: No valid session');
      return;
    }
    spaceId = session.spaceId;
  }
  // ...
}
```

**Note**: WebSocket auth currently relies on session cookies from the upgrade request. Container token support for WebSocket is not yet implemented.

---

## 7. Comparison: User vs Agent Auth

| Aspect | User Auth | Agent Auth |
|--------|-----------|------------|
| **Mechanism** | Mock (dev) / WorkOS (prod) → session cookie | Container token |
| **Header/Cookie** | `cikada_session` cookie | `X-Cikada-Token` header |
| **Scope** | Space-wide | Space + Channel |
| **Identity** | `userId` (WorkOS user ID) | `agent:{callsign}` |
| **Expiration** | Session-based | No expiration (container lifetime) |
| **Revocation** | Session invalidation | Kill container |

**Note**: The reference implementation uses Sanity OAuth, but the reimplementation will use **mock auth** for local development and **WorkOS** for production.

---

## 8. Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CIKADA_CONTAINER_SECRET` | Yes (server) | HMAC signing key |
| `CIKADA_AUTH_TOKEN` | Yes (container) | Token for API calls |
| `CIKADA_API_URL` | Yes (container) | Server base URL |
| `CIKADA_CHANNEL_ID` | Yes (container) | Agent's assigned channel |
| `CIKADA_CALLSIGN` | Yes (container) | Agent's callsign |

---

## 9. Security Considerations

### 9.1 Token Security

- Tokens are not encrypted, only signed (HMAC)
- Token payload is visible if intercepted (base64url decode)
- HMAC prevents tampering but not eavesdropping
- **Recommendation**: Always use HTTPS in production

### 9.2 Secret Rotation

- No built-in secret rotation mechanism
- Rotating `CIKADA_CONTAINER_SECRET` invalidates all existing tokens
- **Process**: Update secret on server, then restart all containers

### 9.3 Token Lifetime

- Tokens do not expire
- Token validity is tied to container lifetime
- When container is killed, token becomes unused (but still valid if secret unchanged)

### 9.4 Attack Vectors

| Vector | Mitigation |
|--------|------------|
| Token theft | HTTPS, container isolation |
| Secret leak | Environment variable protection, secrets management |
| Replay attack | Channel scoping limits blast radius |
| Token forgery | HMAC verification |

---

## 10. Implementation Notes

### 10.1 Local Development

In local dev with `authEnabled: false`, some auth checks are bypassed:

```typescript
// packages/server/src/websocket.ts:85-95
if (authEnabled) {
  const session = await verifySession(req);
  // ...
} else {
  spaceId = 'default';
}
```

### 10.2 AWS Deployment

AWS deployments should:
1. Store `CIKADA_CONTAINER_SECRET` in AWS Secrets Manager
2. Use IAM roles for Fargate tasks to retrieve secrets
3. Ensure ECS task definitions inject secrets as environment variables

---

## 11. Code References

| Component | File | Lines |
|-----------|------|-------|
| Token types | `packages/server/src/auth/container-token.ts` | 36-40 |
| Token generation | `packages/server/src/auth/container-token.ts` | 52-57 |
| Token verification | `packages/server/src/auth/container-token.ts` | 65-98 |
| Auth middleware | `packages/server/src/auth/middleware.ts` | 76-160 |
| Token creation (spawn) | `packages/server/src/agent-manager.ts` | 661, 888 |
| Token env injection | `packages/local-runtime/src/sandbox/docker-orchestrator.ts` | 189-195 |
| Token usage (container) | `packages/fargate-runtime/wrapper/mcp-artifact-server.ts` | 29-32 |
| WebSocket auth | `packages/server/src/websocket.ts` | 83-96 |

