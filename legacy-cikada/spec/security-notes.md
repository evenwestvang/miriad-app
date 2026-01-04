# Security Notes

This document tracks intentional security simplifications and known limitations that should be addressed before production deployment.

## Container Authentication

### HMAC Token-Based Auth

**Status:** Implemented
**Added:** 2026-01-02

**Context:**
Docker containers running Claude Code agents need to access the server API (artifacts, messages, attachments, Tymbal frames) without session cookies. Rather than bypassing auth for specific endpoints, containers authenticate using HMAC tokens.

**Implementation:**
1. When spawning a container, the server generates an HMAC token: `base64(spaceId:channelId:callsign).hmac`
2. Token is passed to container as `CIKADA_AUTH_TOKEN` environment variable
3. Container includes token in all requests via `X-Cikada-Token` header
4. Auth middleware validates token and extracts spaceId/channelId/callsign
5. Container can only access resources in its assigned space/channel

**Security Properties:**
- Token cannot be forged without server secret
- Token is scoped to specific space/channel/agent
- Server secret can be rotated (invalidates all tokens)
- No endpoints need to bypass auth entirely

**Token Format:**
```
base64url(spaceId:channelId:callsign).hmac_sha256_base64url
```

**Configuration:**
- `CIKADA_CONTAINER_SECRET` - Server secret for HMAC (ephemeral if not set)
- Set a persistent secret in production to survive server restarts

## Unauthenticated Endpoints

### `/thread/*` - Docker Container Callbacks

**Status:** Intentionally unauthenticated (legacy, to be migrated to token auth)
**Added:** 2026-01-02

**Context:**
The Tymbal frame callback endpoint remains unauthenticated as a fallback. In the future, the wrapper should also send the auth token with Tymbal frames.

**Risk:**
An attacker who knows a valid `threadId` could inject messages into a channel by POSTing to this endpoint.

**Mitigations (Current):**
- Endpoint only accepts Tymbal frame format
- `threadId` includes `spaceId` which is not publicly exposed
- Messages are tagged with agent sender, not user

**Future Improvements:**
1. Update wrapper to send auth token with Tymbal frames
2. **Internal Network:** In production (ECS/Fargate), use VPC internal networking
3. **Rate Limiting:** Add rate limiting per threadId to prevent abuse

---

## Authentication Model

### Mock OAuth (Development Only)

The `--mock-auth` flag and mock OAuth server are for development only. In production, real Sanity OAuth should be used.

### Session Cookies

Sessions use HTTP-only cookies with:
- `SameSite=None` (required for cross-origin requests)
- `Secure` flag (in production)

---

## Future Work

- [ ] Implement HMAC tokens for container callbacks
- [ ] Add rate limiting on public endpoints
- [ ] Audit all PUBLIC_ROUTES for production readiness
- [ ] Add request signing for inter-service communication
