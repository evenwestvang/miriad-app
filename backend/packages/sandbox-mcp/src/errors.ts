/**
 * Error thrown by sandbox tool handlers.
 * Converted to MCP error responses by the tool wrapper.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'TOOL_ERROR',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function formatError(err: unknown): { error: string; code: string } {
  if (err instanceof ToolError) {
    return { error: err.message, code: err.code };
  }
  if (err instanceof Error) {
    // Daytona SDK errors often have useful messages
    return { error: err.message, code: 'DAYTONA_ERROR' };
  }
  return { error: String(err), code: 'UNKNOWN_ERROR' };
}
