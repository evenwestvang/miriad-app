/**
 * Shared types for tool renderers.
 */

export interface ToolRendererProps {
  args: Record<string, unknown>
  output: unknown
  error?: string
  isSuccess: boolean
}
