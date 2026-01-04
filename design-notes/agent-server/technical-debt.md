# Technical Debt & Cleanup Items

Issues identified during the spec documentation process. These represent inconsistencies, duplication, and gaps that should be addressed in a clean implementation.

---

## Type Inconsistencies

### 1. ParticipantType Mismatch

| Package | Definition |
|---------|-----------|
| `@cikada/core` | `'user' \| 'agent'` |
| `@cikada/handlers` | `'agent' \| 'human'` |

**Impact**: Could cause issues passing roster data between packages.

**Recommendation**: Consolidate to `'user' | 'agent'` (core's definition) since "user" is more general than "human".

**Source**: [[channels-spec]] Section 12.2

---

### 2. ParticipantStatus Mismatch

| Package | Definition |
|---------|-----------|
| `@cikada/core` | `'online' \| 'offline' \| 'busy'` |
| `@cikada/handlers` | `'online' \| 'offline' \| 'active' \| 'idle'` |

**Impact**: Status values may not be compatible between packages.

**Recommendation**: Merge into unified set: `'online' | 'offline' | 'busy' | 'idle'` (where `active` maps to `busy`).

**Source**: [[channels-spec]] Section 12.2

---

### 3. SSE Transport Schema vs Runtime

**Issue**: `artifact-schemas.ts` validates MCP transport as `'stdio' | 'http'`, but runtime code (`agents/resolve.ts`) handles `'sse'` transport.

**Impact**: SSE transport configs would fail schema validation but work at runtime.

**Recommendation**: Add `'sse'` to schema validation.

**Source**: [[artifacts-data-model]]

---

## Code Duplication

### 4. Root Channel Fallback Pattern

Two separate implementations of the channel-local → root fallback:

| Location | Function |
|----------|----------|
| `packages/handlers/src/agents/resolve.ts:110-143` | `resolveAgentDefinition()` |
| `packages/handlers/src/agents/resolve.ts:159-209` | `resolveMcpConfig()` |
| `packages/mcp/src/registry.ts:29-49` | `getArtifactWithFallback()` |

**Impact**: Duplication increases maintenance burden and risk of inconsistent behavior.

**Recommendation**: Consolidate into single helper:
```typescript
function resolveSystemArtifact(
  reader: ArtifactReader,
  channelId: string,
  slug: string,
  type: 'system.agent' | 'system.mcp' | 'system.focus',
  rootChannelId?: string
): Promise<ArtifactData | undefined>
```

**Source**: [[channels-spec]], [[artifacts-storage-versioning]]

---

## Missing API Endpoints

### 5. Roster Entry Updates

**Issue**: `updateRosterEntry` exists in storage interface (`storage/src/interface.ts:207`) but is not exposed via HTTP API.

**Impact**: No way to programmatically update agent status (e.g., `online` → `busy` → `idle`).

**Recommendation**: Add endpoint:
```
PATCH /channels/:id/roster/:participantId
Body: { status?: string, ... }
```

**Source**: [[channels-spec]] Section 12.3

---

## Artifact System Limitations

### 6. No Hard Delete

**Issue**: Artifacts can only be soft-deleted (archived). No way to permanently remove artifacts.

**Impact**: Data accumulates over time; no way to truly delete sensitive content.

**Recommendation**: Add `DELETE /artifacts/:slug?hard=true` with appropriate safeguards.

**Source**: [[artifacts-storage-versioning]]

---

### 7. No Bulk Operations

**Issue**: No bulk create/update/delete operations for artifacts.

**Impact**: Moving or updating many artifacts requires N API calls.

**Recommendation**: Add batch endpoints:
```
POST /artifacts/batch { operations: [...] }
```

**Source**: [[artifacts-storage-versioning]]

---

### 8. Path Staleness on Parent Move

**Issue**: When a parent artifact's slug changes or it's moved, child paths don't update recursively.

**Impact**: Computed `path` field becomes stale, breaking tree navigation.

**Recommendation**: Implement recursive path update on parent changes, or compute paths dynamically.

**Source**: [[artifacts-storage-versioning]]

---

## Agent Communication

### 9. turnId Underutilization

**Issue**: `turnId` field exists on messages but isn't consistently used for grouping request/response pairs.

**Impact**: Difficult to correlate agent responses with triggering messages.

**Recommendation**: Ensure all response messages reference the originating `turnId`.

**Source**: [[agent-communication-spec]]

---

### 10. No Message Retry Mechanism

**Issue**: No built-in retry for failed agent message delivery.

**Impact**: Transient failures can cause lost messages.

**Recommendation**: Add retry queue with exponential backoff for agent delivery failures.

**Source**: [[agent-communication-spec]]

---

### 11. WebSocket Container Token Auth Not Implemented

**Issue**: WebSocket connections only support session cookie authentication, not container tokens.

**Impact**: Agents in containers cannot establish WebSocket connections for real-time streaming — must use HTTP polling or rely on server-side bridging.

**Recommendation**: Extend WebSocket auth middleware to accept container tokens via query parameter or first-message auth.

**Source**: [[agent-auth-spec]]

