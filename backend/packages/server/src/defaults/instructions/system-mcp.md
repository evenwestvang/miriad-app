---
summary: How to configure MCP servers and assign them to agents
---

# MCP Server Configuration

You can configure external MCP (Model Context Protocol) servers to extend agent capabilities with additional tools. MCP servers are defined as `system.mcp` artifacts and assigned to agents via `props.mcp`.

## Creating an MCP Server Definition

Use the `create` artifact tool to define an MCP server:

```
create({
  channel: "my-channel",   // or "root" for global availability
  slug: "github-mcp",
  type: "system.mcp",
  tldr: "GitHub API tools for repo management, PRs, and issues",
  sender: "your-callsign",
  content: "",
  props: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      "GITHUB_TOKEN": "${GITHUB_TOKEN}"
    }
  }
})
```

## Transport Types

### stdio (Command-line MCP servers)

Most MCP servers run as local processes communicating via stdin/stdout:

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
  "env": {
    "SOME_VAR": "value"
  },
  "cwd": "/optional/working/directory"
}
```

**Props:**
- `transport`: `"stdio"` (required)
- `command`: Executable to run (required)
- `args`: Command-line arguments (optional)
- `env`: Environment variables (optional, supports `${VAR}` references)
- `cwd`: Working directory (optional)

### http (Remote MCP servers)

For remote MCP servers accessible via HTTP:

```json
{
  "transport": "http",
  "url": "https://mcp.example.com",
  "headers": {
    "Authorization": "Bearer ${API_KEY}"
  }
}
```

**Props:**
- `transport`: `"http"` (required)
- `url`: Server URL (required)
- `headers`: HTTP headers (optional, supports `${VAR}` references)

## Environment Variable References

Use `${VAR_NAME}` syntax to reference environment variables:

```json
{
  "env": {
    "GITHUB_TOKEN": "${GITHUB_TOKEN}",
    "DEBUG": "true"
  }
}
```

Variables are resolved at agent spawn time from the server's environment. If a variable is not found, a warning is logged and the original `${VAR}` string is preserved.

## Channel Inheritance

MCP definitions follow the same inheritance pattern as other artifacts:

- **Root-level** (`#root` channel): Available to all agents across all channels
- **Channel-level**: Available only to agents in that specific channel
- **Override**: Channel-level definitions with the same slug override root-level

Example: If both `#root` and `#project-x` have a `system.mcp` with slug `github`, agents in `#project-x` will use the channel-level definition.

## Assigning MCPs to Agents

MCPs are not automatically available. Each agent explicitly declares which MCPs it can access via `props.mcp` on the `system.agent` artifact:

```
update({
  channel: "my-channel",
  slug: "builder",  // system.agent slug
  changes: [{
    field: "props",
    old_value: { "engine": "claude" },
    new_value: {
      "engine": "claude",
      "mcp": [
        { "slug": "github-mcp" },
        { "slug": "filesystem" }
      ]
    }
  }],
  sender: "your-callsign"
})
```

Or when creating a new agent:

```
create({
  channel: "my-channel",
  slug: "my-builder",
  type: "system.agent",
  tldr: "Builder agent with GitHub and filesystem access",
  sender: "your-callsign",
  content: "System prompt here...",
  props: {
    "engine": "claude",
    "mcp": [
      { "slug": "github-mcp" },
      { "slug": "filesystem" }
    ]
  }
})
```

## Runtime Behavior

- MCP configuration is loaded at agent spawn time
- Changes to `system.mcp` or agent `props.mcp` do not affect running agents
- Agents must be restarted to pick up configuration changes
- The built-in powpow MCP (artifact tools, messaging) is always provided and cannot be disabled

## Schema Discovery

Use `explain_artifact_type` to get the JSON Schema for valid props:

```
explain_artifact_type({ type: "system.mcp" })
```

This returns the schema for validation along with documentation and examples. When creating/updating artifacts with invalid props, structured error feedback includes the full schema.

## Common MCP Server Examples

### GitHub

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
}
```

### Filesystem (scoped to directory)

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects/myapp"]
}
```

### Sanity CMS

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@sanity/mcp-server@latest"],
  "env": {
    "SANITY_PROJECT_ID": "${SANITY_PROJECT_ID}",
    "SANITY_DATASET": "production",
    "SANITY_API_TOKEN": "${SANITY_API_TOKEN}"
  }
}
```

### Custom Internal API (HTTP)

```json
{
  "transport": "http",
  "url": "https://internal.company.com/mcp",
  "headers": {
    "Authorization": "Bearer ${INTERNAL_API_KEY}"
  }
}
```

## Troubleshooting

**MCP not available to agent:**
- Check the agent's `props.mcp` includes the MCP slug
- Verify the `system.mcp` artifact exists in the agent's channel or `#root`
- Ensure the engine supports MCP (`supportsMcp: true` in capabilities)

**Environment variable not resolved:**
- Check the variable is set in the server's environment
- Variable names are case-sensitive

**Connection errors:**
- For stdio: verify the command path and arguments are correct
- For http: verify the URL is accessible from the server
