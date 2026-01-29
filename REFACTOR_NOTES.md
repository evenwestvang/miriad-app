# N+1 Refactor Notes

## Current State
The batch queries are implemented but not fully wired up:
- `mcpArtifacts` is fetched but not used
- `context.environments` is fetched but not used

## What Can Be Optimized

### Environment Resolution
- `context.environments` already has the environment artifacts
- Still need to decrypt secrets (per-request, can't batch)
- **Change:** Pass `context.environments` into `resolveEnvironment()` instead of re-fetching

### MCP Config Resolution
- `mcpArtifacts` already has the system.mcp artifacts
- Still need OAuth token injection (per-request)
- Still need platform MCPs (miriad, miriad-files) - no fetch needed
- **Change:** Pass `mcpArtifacts` into `deriveMcpConfigsFromSystemMcps()` instead of re-fetching

## What Cannot Be Optimized
- Secrets decryption - per-request by design (security)
- OAuth token injection - per-request (tokens are fresh)
- Platform MCPs - no fetch, just construction

## Recommended Approach

1. Add overload to `resolveEnvironment()`:
```typescript
// New signature that accepts pre-fetched data
async resolveEnvironmentFromContext(
  spaceId: string,
  channelId: string,
  environments: EnvironmentArtifactData[],
  rootChannelId: string | null,
): Promise<Record<string, string>>
```

2. Add overload to `deriveMcpConfigsFromSystemMcps()`:
```typescript
// New signature that accepts pre-fetched data
async deriveMcpConfigsFromContext(
  mcpArtifacts: Map<string, McpArtifactData>,
  agentDefinition: AgentDefinitionSummary,
  channelId: string,
): Promise<McpServerConfig[]>
```

3. Update invoker-adapter to use new signatures with pre-fetched data.
