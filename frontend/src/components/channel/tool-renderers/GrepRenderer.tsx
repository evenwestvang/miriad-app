/**
 * Grep tool renderer - displays search results.
 *
 * Shows:
 * - Search pattern with regex indicator
 * - Result count and file list
 * - Modes: files_with_matches, content, count
 * - Matching lines with context if content mode
 */
import type { ToolRendererProps } from './types'

export function GrepRenderer({ args, output, error, isSuccess }: ToolRendererProps) {
  // TODO: Implement based on wireframe design
  // Extract: pattern, output_mode, path from args
  // Show: search results based on mode

  return (
    <div className="text-xs font-mono text-muted-foreground">
      Grep renderer - TODO: Implement based on wireframes
      <pre>{JSON.stringify({ args, output, error, isSuccess }, null, 2)}</pre>
    </div>
  )
}
