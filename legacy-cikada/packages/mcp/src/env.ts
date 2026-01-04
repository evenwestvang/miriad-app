/**
 * Environment Variable Resolution
 *
 * Resolves ${VAR_NAME} references in MCP config values to actual
 * environment variable values from process.env.
 */

/**
 * Resolve ${VAR_NAME} references in a string to actual environment variable values.
 *
 * @param value - String potentially containing ${VAR} references
 * @returns String with ${VAR} replaced by process.env[VAR], or original if not found
 *
 * @example
 * // process.env.API_KEY = "secret123"
 * resolveEnvVarString("Bearer ${API_KEY}") // "Bearer secret123"
 * resolveEnvVarString("${MISSING}") // "${MISSING}" (unchanged)
 */
export function resolveEnvVarString(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.error(`[mcp] Warning: env var ${varName} not found, leaving as ${match}`);
      return match; // Keep original if not found
    }
    return envValue;
  });
}

/**
 * Resolve ${VAR_NAME} references in all values of an object.
 *
 * @param obj - Object with string values potentially containing ${VAR} references
 * @returns New object with all ${VAR} references resolved
 *
 * @example
 * // process.env.GITHUB_TOKEN = "ghp_xxx"
 * resolveEnvVars({ TOKEN: "${GITHUB_TOKEN}", DEBUG: "true" })
 * // { TOKEN: "ghp_xxx", DEBUG: "true" }
 */
export function resolveEnvVars(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveEnvVarString(value);
  }
  return result;
}

/**
 * Check if a string contains any ${VAR} references.
 *
 * @param value - String to check
 * @returns true if contains ${...} pattern
 */
export function hasEnvVarRefs(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

/**
 * Extract all ${VAR} names from a string.
 *
 * @param value - String to extract from
 * @returns Array of variable names (without ${})
 *
 * @example
 * extractEnvVarNames("${FOO} and ${BAR}") // ["FOO", "BAR"]
 */
export function extractEnvVarNames(value: string): string[] {
  const matches = value.matchAll(/\$\{([^}]+)\}/g);
  return Array.from(matches, m => m[1]);
}
