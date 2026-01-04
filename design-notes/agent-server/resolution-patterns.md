# Resolution Patterns

This document describes the cross-cutting resolution pattern used throughout the Cast backend for looking up system artifacts.

## Channel-Local → Root Fallback Pattern

When resolving system artifacts (`system.agent`, `system.mcp`, `system.focus`), the backend follows a consistent two-step lookup:

1. **Check channel-local artifacts first** — Look in the current channel's board
2. **Fall back to root channel** — If not found (or wrong type), check `#root`

This allows channels to override system artifacts with local customizations while inheriting defaults from root.

## Implementations

The pattern is currently implemented in multiple locations:

### 1. Agent Definition Resolution

**Location**: `packages/handlers/src/agents/resolve.ts:110-143`

```typescript
async function resolveAgentDefinition(
  storage: Storage,
  spaceId: string,
  channelId: string,
  slug: string
): Promise<ResolvedAgentDefinition | undefined>
```

- Resolves `system.agent` artifacts
- Returns agent config including system prompt, engine, model, MCP refs

### 2. MCP Server Resolution

**Location**: `packages/handlers/src/agents/resolve.ts:159-209`

```typescript
async function resolveMcpConfig(
  storage: Storage,
  spaceId: string,
  channelId: string,
  slug: string
): Promise<McpServerConfig | undefined>
```

- Resolves `system.mcp` artifacts
- Handles environment variable substitution in `env` records
- Handles URL placeholders (`${ENV_VAR}`, `{channelId}`)

### 3. Generic Artifact Fallback

**Location**: `packages/mcp/src/registry.ts:29-49`

```typescript
async function getArtifactWithFallback(
  storage: Storage,
  spaceId: string,
  channelId: string,
  slug: string
): Promise<Artifact | undefined>
```

- Generic helper for any artifact type
- Used by MCP registry for tool access

## Consolidation Opportunity

These implementations are functionally similar but duplicated. A unified helper would reduce duplication:

```typescript
async function resolveSystemArtifact<T>(
  storage: Storage,
  spaceId: string,
  channelId: string,
  slug: string,
  type: ArtifactType
): Promise<T | undefined>
```

This is tracked in [[technical-debt]].

## Related Specs

- [[channels-spec]] — Agent and MCP resolution in context of channel lifecycle
- [[artifacts-data-model]] — System artifact types and props schemas
