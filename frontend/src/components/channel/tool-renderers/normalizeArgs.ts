/**
 * Normalize tool arguments to handle naming differences between engines.
 * 
 * Nuum uses camelCase: filePath, oldString, newString
 * Claude SDK uses snake_case: file_path, old_string, new_string
 * 
 * This normalizes everything to camelCase for consistent renderer code.
 */
export function normalizeArgs<T extends Record<string, unknown>>(args: T): T {
  const normalized: Record<string, unknown> = {}
  
  for (const [key, value] of Object.entries(args)) {
    // snake_case → camelCase
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    normalized[camelKey] = value
  }
  
  return normalized as T
}
