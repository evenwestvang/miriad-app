/**
 * Tool Renderer Registry
 *
 * Custom renderers for specific tool types. Each renderer receives the tool args
 * and output, and returns a React node. If a tool has a custom renderer, it replaces
 * the default JSON display.
 *
 * To add a new renderer:
 * 1. Create a new file (e.g., ReadRenderer.tsx) that exports a component with ToolRendererProps
 * 2. Import it here and add to the toolRenderers map with the tool name as key
 */

import type { ToolRendererProps } from './types'
import { BashRenderer } from './BashRenderer'
import { ReadRenderer } from './ReadRenderer'
import { WriteRenderer } from './WriteRenderer'
import { EditRenderer } from './EditRenderer'
import { GrepRenderer } from './GrepRenderer'
import { GlobRenderer } from './GlobRenderer'
import { ArtifactCreateRenderer } from './ArtifactCreateRenderer'
import { ArtifactReadRenderer } from './ArtifactReadRenderer'
import { ArtifactEditRenderer } from './ArtifactEditRenderer'
import { ArtifactListRenderer } from './ArtifactListRenderer'
import { SetStatusRenderer } from './SetStatusRenderer'
import { WebFetchRenderer } from './WebFetchRenderer'
import { WebSearchRenderer } from './WebSearchRenderer'
import { TaskRenderer } from './TaskRenderer'
import { SendMessageRenderer } from './SendMessageRenderer'
import { ArtifactUpdateRenderer } from './ArtifactUpdateRenderer'
import { ArtifactGlobRenderer } from './ArtifactGlobRenderer'
import { ArtifactCheckpointRenderer } from './ArtifactCheckpointRenderer'
import { SetMissionRenderer } from './SetMissionRenderer'
import { UpdateTasksRenderer } from './UpdateTasksRenderer'
import { getToolDisplayName, isToolHidden } from './toolConfig'

// Export the shared types and config helpers
export type { ToolRendererProps }
export { getToolDisplayName, isToolHidden }

/**
 * Normalize tool name by stripping MCP prefixes and converting to lowercase.
 * 
 * Handles naming variations across different engines/versions:
 * - mcp__cast__artifact_read → artifact_read
 * - mcp__miriad__artifact_read → artifact_read
 * - miriad__artifact_read → artifact_read
 * - Bash → bash
 * 
 * Note: present_* tools are NOT normalized - they're semantically different
 * from miriad__* tools (e.g., present_set_status vs miriad__set_status).
 * 
 * Note: mcp_status (single underscore) is a different tool - don't normalize it.
 */
export function normalizeToolName(toolName: string): string {
  let name = toolName.toLowerCase()
  
  // Don't normalize mcp_status - it's a distinct tool
  if (name === 'mcp_status') return name
  
  // Don't normalize present_* tools - they're distinct from miriad__* tools
  if (name.startsWith('present_')) return name
  
  // Strip MCP prefixes: mcp__cast__, mcp__miriad__, miriad__
  name = name.replace(/^mcp__(cast|miriad)__/, '')
  name = name.replace(/^miriad__/, '')
  
  return name
}

/**
 * Registry of custom tool renderers.
 * Keys are normalized tool names (no prefixes, lowercase).
 */
export const toolRenderers: Record<string, React.ComponentType<ToolRendererProps>> = {
  // File operations
  'bash': BashRenderer,
  'run_bash': BashRenderer,
  'read': ReadRenderer,
  'write': WriteRenderer,
  'edit': EditRenderer,
  'grep': GrepRenderer,
  'glob': GlobRenderer,
  
  // Artifact operations
  'artifact_create': ArtifactCreateRenderer,
  'artifact_read': ArtifactReadRenderer,
  'artifact_edit': ArtifactEditRenderer,
  'artifact_list': ArtifactListRenderer,
  'artifact_update': ArtifactUpdateRenderer,
  'artifact_glob': ArtifactGlobRenderer,
  'artifact_checkpoint': ArtifactCheckpointRenderer,
  
  // Communication
  'send_message': SendMessageRenderer,
  'set_status': SetStatusRenderer,
  
  // Present state tools (agent's current focus)
  'present_set_mission': SetMissionRenderer,
  'present_update_tasks': UpdateTasksRenderer,
  
  // Web tools
  'webfetch': WebFetchRenderer,
  'web_fetch': WebFetchRenderer,
  'websearch': WebSearchRenderer,
  'web_search': WebSearchRenderer,
  
  // Tasks
  'task': TaskRenderer,
}

/**
 * Check if a tool has a custom renderer.
 */
export function hasCustomRenderer(toolName: string): boolean {
  return normalizeToolName(toolName) in toolRenderers
}

/**
 * Get the custom renderer for a tool, if one exists.
 */
export function getToolRenderer(toolName: string): React.ComponentType<ToolRendererProps> | null {
  return toolRenderers[normalizeToolName(toolName)] || null
}
