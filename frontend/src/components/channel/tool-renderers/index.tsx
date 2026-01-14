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

// Export the shared types
export type { ToolRendererProps }

/**
 * Registry of custom tool renderers.
 * Keys are lowercase tool names.
 */
export const toolRenderers: Record<string, React.ComponentType<ToolRendererProps>> = {
  'bash': BashRenderer,
  'run_bash': BashRenderer,
  'read': ReadRenderer,
  'write': WriteRenderer,
  'edit': EditRenderer,
  'grep': GrepRenderer,
  'glob': GlobRenderer,
  'mcp__cast__artifact_create': ArtifactCreateRenderer,
  'mcp__cast__artifact_read': ArtifactReadRenderer,
  'mcp__cast__artifact_edit': ArtifactEditRenderer,
  'mcp__cast__artifact_list': ArtifactListRenderer,
  'mcp__cast__set_status': SetStatusRenderer,
  'webfetch': WebFetchRenderer,
  'websearch': WebSearchRenderer,
  'task': TaskRenderer,
}

/**
 * Check if a tool has a custom renderer.
 */
export function hasCustomRenderer(toolName: string): boolean {
  return toolName.toLowerCase() in toolRenderers
}

/**
 * Get the custom renderer for a tool, if one exists.
 */
export function getToolRenderer(toolName: string): React.ComponentType<ToolRendererProps> | null {
  return toolRenderers[toolName.toLowerCase()] || null
}
