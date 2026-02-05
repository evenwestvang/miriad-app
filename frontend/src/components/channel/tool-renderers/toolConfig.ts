/**
 * Tool Configuration - Single source of truth for tool display and behavior.
 * 
 * This config handles:
 * - Display names (friendly names for UI)
 * - Hidden flags (tools that shouldn't be rendered)
 * - Renderer component references
 * 
 * Keys are normalized tool names (no prefixes, lowercase).
 * Use normalizeToolName() to convert raw tool names before lookup.
 */

export interface ToolConfig {
  /** Friendly display name for the UI */
  displayName: string
  /** If true, tool calls are filtered out and not rendered */
  hidden?: boolean
}

/**
 * Tool configuration lookup table.
 * Keys are normalized tool names (lowercase, no prefixes).
 */
export const TOOL_CONFIG: Record<string, ToolConfig> = {
  // === Hidden tools (reflected elsewhere in UI) ===
  'send_message': { displayName: 'Send message', hidden: true },
  'set_status': { displayName: 'Set status', hidden: true },
  
  // === File operations ===
  'bash': { displayName: 'Run command' },
  'run_bash': { displayName: 'Run command' },
  'read': { displayName: 'Read file' },
  'read_file': { displayName: 'Read file' },
  'write': { displayName: 'Write file' },
  'edit': { displayName: 'Edit file' },
  'grep': { displayName: 'Search files' },
  'glob': { displayName: 'Find files' },
  
  // === Artifact operations ===
  'artifact_create': { displayName: 'Create artifact' },
  'artifact_read': { displayName: 'Read artifact' },
  'artifact_edit': { displayName: 'Edit artifact' },
  'artifact_list': { displayName: 'List artifacts' },
  'artifact_update': { displayName: 'Update artifact' },
  'artifact_glob': { displayName: 'Browse artifacts' },
  'artifact_checkpoint': { displayName: 'Checkpoint artifact' },
  'artifact_archive': { displayName: 'Archive artifact' },
  'artifact_copy': { displayName: 'Copy artifact' },
  'artifact_diff': { displayName: 'Diff artifact' },
  
  // === Present state tools (keep present_ prefix - distinct namespace) ===
  'present_set_mission': { displayName: 'Set mission' },
  'present_set_status': { displayName: 'Set status' },
  'present_update_tasks': { displayName: 'Update tasks' },
  
  // === Message/channel tools ===
  'get_messages': { displayName: 'Get messages' },
  'message_get': { displayName: 'Get messages' },
  'message_search': { displayName: 'Search messages' },
  'get_roster': { displayName: 'Get roster' },
  'structured_ask': { displayName: 'Ask question' },
  
  // === Web tools ===
  'web_fetch': { displayName: 'Fetch page' },
  'webfetch': { displayName: 'Fetch page' },
  'web_search': { displayName: 'Web search' },
  'websearch': { displayName: 'Web search' },
  
  // === Knowledge base tools ===
  'kb_list': { displayName: 'List KBs' },
  'kb_glob': { displayName: 'Browse KB' },
  'kb_read': { displayName: 'Read KB doc' },
  'kb_query': { displayName: 'Search KB' },
  
  // === LTM tools ===
  'ltm_search': { displayName: 'Search memory' },
  'ltm_read': { displayName: 'Read memory' },
  'ltm_glob': { displayName: 'Browse memory' },
  
  // === Background tasks ===
  'list_tasks': { displayName: 'List tasks' },
  'set_alarm': { displayName: 'Set alarm' },
  'background_research': { displayName: 'Research' },
  'background_reflect': { displayName: 'Reflect' },
  'cancel_task': { displayName: 'Cancel task' },
  
  // === Asset tools ===
  'upload_asset': { displayName: 'Upload file' },
  'download_asset': { displayName: 'Download file' },
  
  // === System tools ===
  'mcp_status': { displayName: 'MCP status' },
  'read_instructions': { displayName: 'Read docs' },
  'list_agent_types': { displayName: 'List agents' },
  'explain_artifact_type': { displayName: 'Explain type' },
}

/**
 * Get the display name for a tool.
 * Returns the friendly name if configured, otherwise formats the raw name.
 */
export function getToolDisplayName(normalizedName: string): string {
  const config = TOOL_CONFIG[normalizedName]
  if (config) {
    return config.displayName
  }
  
  // Fallback: convert snake_case to Title Case
  return normalizedName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Check if a tool should be hidden from the UI.
 */
export function isToolHidden(normalizedName: string): boolean {
  return TOOL_CONFIG[normalizedName]?.hidden === true
}
