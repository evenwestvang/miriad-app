import { useState } from 'react'
import { ChevronDown, ChevronRight, Shield } from 'lucide-react'
import { EditableField } from '../ui/editable-field'
import { EnvEditor, type SecretMetadata } from '../ui/env-editor'
import { KeyValueEditor, KeyValuePair } from '../ui/key-value-editor'
import { SegmentedControl } from '../ui/segmented-control'
import { StringListEditor } from '../ui/string-list-editor'
import { OAuthConnectButton } from './OAuthConnectButton'
import { cn } from '../../lib/utils'

// MCP props types - matches server schema
type McpTransport = 'stdio' | 'http'

export interface McpProps {
  transport: McpTransport
  // stdio transport fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // http transport fields
  url?: string
  headers?: Record<string, string>
  // Description
  capabilities?: string
  // Auth (placeholder for future)
  auth?: {
    type: 'oauth'
    authorizationEndpoint?: string
    tokenEndpoint?: string
    clientId?: string
    scopes?: string[]
  }
}

interface McpPropsEditorProps {
  props: McpProps
  onChange: (updates: Partial<McpProps>) => void
  /** Channel containing this MCP artifact (for OAuth and secrets) */
  channel?: string
  /** MCP artifact slug (for OAuth and secrets) */
  mcpSlug?: string
  /** Secrets metadata for this MCP artifact */
  secrets?: Record<string, SecretMetadata>
}

export function McpPropsEditor({ props, onChange, channel, mcpSlug, secrets }: McpPropsEditorProps) {
  const transport = props.transport || 'stdio'
  const [oauthExpanded, setOauthExpanded] = useState(props.auth?.type === 'oauth')

  // Check if OAuth is enabled
  const hasOAuth = props.auth?.type === 'oauth'

  // Toggle OAuth on/off
  const toggleOAuth = (enabled: boolean) => {
    if (enabled) {
      onChange({
        auth: {
          type: 'oauth',
          scopes: [],
        },
      })
      setOauthExpanded(true)
    } else {
      onChange({ auth: undefined })
      setOauthExpanded(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Transport Type */}
      <SegmentedControl<McpTransport>
        label="Transport"
        value={transport}
        onChange={(value) => onChange({ transport: value })}
        options={[
          { value: 'stdio', label: 'stdio' },
          { value: 'http', label: 'http' },
        ]}
      />

      {/* stdio transport fields */}
      {transport === 'stdio' && (
        <div className="space-y-3">
          {/* Command */}
          <EditableField
            label="Command"
            value={props.command || ''}
            onChange={(value) => onChange({ command: value || undefined })}
            placeholder="e.g., npx"
          />

          {/* Arguments */}
          <StringListEditor
            label="Arguments"
            items={props.args || []}
            onChange={(items) => onChange({ args: items.length > 0 ? items : undefined })}
            placeholder="e.g., -y @modelcontextprotocol/server-github"
          />

          {/* Working Directory */}
          <EditableField
            label="Working Directory"
            value={props.cwd || ''}
            onChange={(value) => onChange({ cwd: value || undefined })}
            placeholder="/path/to/working/dir"
          />

          {/* Environment Variables and Secrets */}
          {channel && mcpSlug ? (
            <EnvEditor
              variables={props.env || {}}
              secrets={secrets || {}}
              artifactSlug={mcpSlug}
              channelId={channel}
              onVariablesChange={(variables) => onChange({ env: Object.keys(variables).length > 0 ? variables : undefined })}
              showExpansionHint
            />
          ) : (
            <KeyValueEditor
              label="Environment Variables"
              entries={envToEntries(props.env)}
              onChange={(entries) => onChange({ env: entriesToEnv(entries) })}
              keyPlaceholder="VARIABLE_NAME"
              valuePlaceholder="value or ${ENV_REF}"
            />
          )}
        </div>
      )}

      {/* http transport fields */}
      {transport === 'http' && (
        <div className="space-y-3">
          {/* URL */}
          <EditableField
            label="URL"
            value={props.url || ''}
            onChange={(value) => onChange({ url: value || undefined })}
            placeholder="https://mcp.example.com/sse"
          />

          {/* Headers */}
          <KeyValueEditor
            label="Headers"
            entries={envToEntries(props.headers)}
            onChange={(entries) => onChange({ headers: entriesToEnv(entries) })}
            keyPlaceholder="Header-Name"
            valuePlaceholder="value or ${ENV_REF}"
          />

          {/* Environment Variables and Secrets */}
          {channel && mcpSlug ? (
            <EnvEditor
              variables={props.env || {}}
              secrets={secrets || {}}
              artifactSlug={mcpSlug}
              channelId={channel}
              onVariablesChange={(variables) => onChange({ env: Object.keys(variables).length > 0 ? variables : undefined })}
              showExpansionHint
            />
          ) : (
            <KeyValueEditor
              label="Environment Variables"
              entries={envToEntries(props.env)}
              onChange={(entries) => onChange({ env: entriesToEnv(entries) })}
              keyPlaceholder="VARIABLE_NAME"
              valuePlaceholder="value or ${ENV_REF}"
            />
          )}

          {/* OAuth Authentication Section */}
          <div className="rounded-md border bg-secondary/10">
            {/* OAuth header with toggle */}
            <button
              type="button"
              onClick={() => hasOAuth ? setOauthExpanded(!oauthExpanded) : toggleOAuth(true)}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2 text-left",
                "hover:bg-secondary/20 rounded-t-md transition-colors"
              )}
            >
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-medium">OAuth 2.1 Authentication</span>
                {hasOAuth && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    Enabled
                  </span>
                )}
              </div>
              {hasOAuth && (
                oauthExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )
              )}
              {!hasOAuth && (
                <span className="text-xs text-muted-foreground">Click to enable</span>
              )}
            </button>

            {/* OAuth configuration (expanded) */}
            {hasOAuth && oauthExpanded && (
              <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border/50">
                {/* Connection status and button */}
                {channel && mcpSlug && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1.5">
                      Connection Status
                    </div>
                    <OAuthConnectButton
                      channel={channel}
                      mcpSlug={mcpSlug}
                    />
                  </div>
                )}

                {/* Authorization Endpoint (optional override) */}
                <EditableField
                  label="Authorization Endpoint (optional)"
                  value={props.auth?.authorizationEndpoint || ''}
                  onChange={(value) =>
                    onChange({
                      auth: {
                        ...props.auth,
                        type: 'oauth',
                        authorizationEndpoint: value || undefined,
                      },
                    })
                  }
                  placeholder="Auto-discovered from server"
                />

                {/* Token Endpoint (optional override) */}
                <EditableField
                  label="Token Endpoint (optional)"
                  value={props.auth?.tokenEndpoint || ''}
                  onChange={(value) =>
                    onChange({
                      auth: {
                        ...props.auth,
                        type: 'oauth',
                        tokenEndpoint: value || undefined,
                      },
                    })
                  }
                  placeholder="Auto-discovered from server"
                />

                {/* Client ID (optional override) */}
                <EditableField
                  label="Client ID (optional)"
                  value={props.auth?.clientId || ''}
                  onChange={(value) =>
                    onChange({
                      auth: {
                        ...props.auth,
                        type: 'oauth',
                        clientId: value || undefined,
                      },
                    })
                  }
                  placeholder="Uses dynamic registration if not set"
                />

                {/* Scopes */}
                <StringListEditor
                  label="Scopes"
                  items={props.auth?.scopes || []}
                  onChange={(items) =>
                    onChange({
                      auth: {
                        ...props.auth,
                        type: 'oauth',
                        scopes: items.length > 0 ? items : undefined,
                      },
                    })
                  }
                  placeholder="e.g., read, write"
                />

                {/* Disable OAuth button */}
                <div className="pt-2 border-t border-border/50">
                  <button
                    type="button"
                    onClick={() => toggleOAuth(false)}
                    className="text-xs text-destructive hover:text-destructive/80"
                  >
                    Disable OAuth
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Capabilities (shared between both transports) */}
      <EditableField
        label="Capabilities"
        value={props.capabilities || ''}
        onChange={(value) => onChange({ capabilities: value || undefined })}
        placeholder="Describe what this MCP server provides..."
        multiline
        minHeight="min-h-[4rem]"
      />
    </div>
  )
}

/**
 * Convert Record<string, string> to KeyValuePair[]
 */
function envToEntries(env: Record<string, string> | undefined): KeyValuePair[] {
  if (!env) return []
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

/**
 * Convert KeyValuePair[] to Record<string, string> or undefined
 */
function entriesToEnv(entries: KeyValuePair[]): Record<string, string> | undefined {
  const env = entries.reduce((acc, { key, value }) => {
    if (key) acc[key] = value
    return acc
  }, {} as Record<string, string>)
  return Object.keys(env).length > 0 ? env : undefined
}
