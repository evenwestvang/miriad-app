import { EditableField } from '../ui/editable-field'
import { EnvEditor, type SecretMetadata } from '../ui/env-editor'
import { KeyValueEditor, KeyValuePair } from '../ui/key-value-editor'
import { SegmentedControl } from '../ui/segmented-control'
import { StringListEditor } from '../ui/string-list-editor'
import { OAuthConnectButton } from './OAuthConnectButton'
import { API_HOST } from '../../lib/api'

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
  // Description
  capabilities?: string
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
  /** Whether we're in create mode (secrets disabled) */
  isCreateMode?: boolean
}

export function McpPropsEditor({ props, onChange, channel, mcpSlug, secrets, isCreateMode }: McpPropsEditorProps) {
  const transport = props.transport || 'stdio'

  return (
    <div className="space-y-8">
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
        <div className="space-y-6">
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

          {/* Environment Variables and Secrets */}
          {channel && mcpSlug && !isCreateMode ? (
            <EnvEditor
              variables={props.env || {}}
              secrets={secrets || {}}
              artifactSlug={mcpSlug}
              channelId={channel}
              onVariablesChange={(variables) => onChange({ env: Object.keys(variables).length > 0 ? variables : undefined })}
              showExpansionHint
            />
          ) : (
            <>
              <KeyValueEditor
                label="Environment Variables"
                entries={envToEntries(props.env)}
                onChange={(entries) => onChange({ env: entriesToEnv(entries) })}
                keyPlaceholder="VARIABLE_NAME"
                valuePlaceholder="value or ${ENV_REF}"
              />
              {isCreateMode && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-muted-foreground uppercase">
                    Secrets
                  </label>
                  <div className="text-base text-muted-foreground">
                    Secrets can be added after you have created the MCP server
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* http transport fields */}
      {transport === 'http' && (
        <div className="space-y-6">
          {/* URL */}
          <EditableField
            label="URL"
            value={props.url || ''}
            onChange={(value) => onChange({ url: value || undefined })}
            placeholder="https://mcp.example.com/sse"
          />

          {/* OAuth Authentication */}
          {channel && mcpSlug && !isCreateMode && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-muted-foreground uppercase">
                Authentication
              </label>
              <OAuthConnectButton
                channel={channel}
                mcpSlug={mcpSlug}
                baseUrl={API_HOST}
              />
            </div>
          )}
          {isCreateMode && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-muted-foreground uppercase">
                Authentication
              </label>
              <div className="text-base text-muted-foreground">
                OAuth can be configured after creating the MCP server
              </div>
            </div>
          )}
        </div>
      )}

      {/* Capabilities (shared between both transports) */}
      <EditableField
        label="Capabilities"
        value={props.capabilities || ''}
        onChange={(value) => onChange({ capabilities: value || undefined })}
        placeholder="Optionally describe MCP capabilities"
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
