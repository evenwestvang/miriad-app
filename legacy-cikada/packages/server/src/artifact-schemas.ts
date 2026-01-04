/**
 * Artifact Props Schemas
 *
 * Zod-based validation schemas for system artifact props.
 * Provides type-safe validation and JSON Schema generation for
 * system.mcp, system.agent, and other structured artifact types.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ============================================================================
// system.mcp props schema
// ============================================================================

/**
 * OAuth authentication configuration for HTTP MCP servers.
 * Supports OAuth 2.1 with PKCE (required by MCP spec).
 */
export const OAuthConfigSchema = z.object({
  type: z.literal("oauth").describe("OAuth 2.1 authentication (PKCE required)"),
  // Optional manual endpoint overrides - auto-discovered via RFC8414 by default
  authorizationEndpoint: z
    .string()
    .url()
    .optional()
    .describe("Authorization endpoint URL (auto-discovered if not set)"),
  tokenEndpoint: z
    .string()
    .url()
    .optional()
    .describe("Token endpoint URL (auto-discovered if not set)"),
  clientId: z
    .string()
    .optional()
    .describe("OAuth client ID (uses default if not set)"),
  scopes: z
    .array(z.string())
    .optional()
    .describe("OAuth scopes to request"),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

/**
 * Schema for system.mcp artifact props.
 * Defines MCP server configuration for stdio or http transports.
 */
export const SystemMcpPropsSchema = z
  .object({
    transport: z.enum(["stdio", "http"]).describe("Transport type for the MCP server"),

    // stdio transport fields
    command: z
      .string()
      .optional()
      .describe("Command to execute for stdio transport (e.g., 'npx', 'node')"),
    args: z
      .array(z.string())
      .optional()
      .describe("Arguments to pass to the command"),
    env: z
      .record(z.string())
      .optional()
      .describe("Environment variables. Use ${VAR_NAME} syntax to reference server env vars"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command"),

    // http transport fields
    url: z
      .string()
      .url()
      .optional()
      .describe("URL for HTTP transport MCP server"),
    headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers. Use ${VAR_NAME} syntax to reference server env vars"),

    // OAuth authentication (for HTTP transport only)
    auth: OAuthConfigSchema.optional().describe(
      "OAuth 2.1 authentication config (HTTP transport only)"
    ),

    // Description field
    capabilities: z
      .string()
      .optional()
      .describe("Human-readable description of what this MCP server provides"),
  })
  .superRefine((data, ctx) => {
    // Transport-specific field validation
    if (data.transport === "stdio" && !data.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio transport requires 'command'",
        path: ["command"],
      });
    }
    if (data.transport === "http" && !data.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http transport requires 'url'",
        path: ["url"],
      });
    }
    // OAuth auth requires http transport
    if (data.auth?.type === "oauth" && data.transport !== "http") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OAuth authentication requires 'http' transport",
        path: ["auth"],
      });
    }
    // OAuth and manual Authorization header are mutually exclusive
    if (data.auth?.type === "oauth" && data.headers?.Authorization) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot use both OAuth auth and manual Authorization header",
        path: ["auth"],
      });
    }
  });

export type SystemMcpProps = z.infer<typeof SystemMcpPropsSchema>;

// ============================================================================
// system.agent props schema
// ============================================================================

/**
 * MCP reference in system.agent props.
 * References a system.mcp artifact by slug.
 */
export const McpReferenceSchema = z.object({
  slug: z.string().describe("Slug of the system.mcp artifact to use"),
});

export type McpReference = z.infer<typeof McpReferenceSchema>;

/**
 * Schema for system.agent artifact props.
 * Defines agent configuration including engine, model, and MCP servers.
 */
export const SystemAgentPropsSchema = z.object({
  engine: z
    .string()
    .describe("AI engine to use (e.g., 'claude', 'codex', or custom backend name)"),
  model: z
    .string()
    .optional()
    .describe("Model to use within the engine (e.g., 'claude-sonnet-4-20250514')"),
  nameTheme: z
    .string()
    .optional()
    .describe("Name theme for generating agent callsigns"),
  agentName: z
    .string()
    .optional()
    .describe("Fixed agent name (for singleton agents)"),
  mcp: z
    .array(McpReferenceSchema)
    .optional()
    .describe("List of MCP servers to provide to this agent"),
});

export type SystemAgentProps = z.infer<typeof SystemAgentPropsSchema>;

// ============================================================================
// system.focus props schema
// ============================================================================

/**
 * Schema for system.focus artifact props.
 * Defines channel template configuration with required agents and defaults.
 */
export const SystemFocusPropsSchema = z.object({
  agents: z
    .array(z.string())
    .min(1, "At least one agent slug is required")
    .describe("List of agent slugs to spawn when channel is created"),
  defaultTagline: z
    .string()
    .optional()
    .describe("Default tagline for channels using this focus"),
  defaultMission: z
    .string()
    .optional()
    .describe("Default mission for channels using this focus"),
  initialPrompt: z
    .string()
    .optional()
    .describe("Initial prompt to send when channel is created"),
});

export type SystemFocusProps = z.infer<typeof SystemFocusPropsSchema>;

// ============================================================================
// Schema Registry
// ============================================================================

/**
 * Registry of Zod schemas for artifact props by type.
 * Used for validation and JSON Schema generation.
 */
export const ARTIFACT_PROPS_SCHEMAS: Record<string, z.ZodSchema> = {
  "system.mcp": SystemMcpPropsSchema,
  "system.agent": SystemAgentPropsSchema,
  "system.focus": SystemFocusPropsSchema,
};

// ============================================================================
// JSON Schema Conversion
// ============================================================================

/**
 * Get JSON Schema for a specific artifact type's props.
 * Returns null if no schema is defined for the type.
 */
export function getJsonSchema(type: string): object | null {
  const schema = ARTIFACT_PROPS_SCHEMAS[type];
  if (!schema) return null;
  return zodToJsonSchema(schema, {
    name: `${type}Props`,
    $refStrategy: "none", // Inline all refs for simpler schema
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validation error with structured details.
 */
export interface PropsValidationError {
  error: "props_validation_failed";
  message: string;
  violations: Array<{
    path: string;
    message: string;
    received?: unknown;
  }>;
  schema: object;
}

/**
 * Validate props for a given artifact type.
 * Returns undefined if valid, or a structured error object if invalid.
 */
export function validateArtifactProps(
  type: string,
  props: unknown
): PropsValidationError | undefined {
  const schema = ARTIFACT_PROPS_SCHEMAS[type];
  if (!schema) {
    // No schema defined for this type - no validation required
    return undefined;
  }

  const result = schema.safeParse(props);
  if (result.success) {
    return undefined;
  }

  // Build structured error with schema echo
  const violations = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
    received: issue.code === "invalid_type" ? (issue as any).received : undefined,
  }));

  return {
    error: "props_validation_failed",
    message: `Invalid props for ${type}`,
    violations,
    schema: getJsonSchema(type)!,
  };
}

/**
 * Validate props and throw if invalid.
 * Use this for synchronous validation in store operations.
 */
export function assertValidProps(type: string, props: unknown): void {
  const error = validateArtifactProps(type, props);
  if (error) {
    // Format error message with violations for thrown error
    const violationLines = error.violations
      .map((v) => `  - ${v.path}: ${v.message}`)
      .join("\n");
    throw new Error(`${error.message}:\n${violationLines}`);
  }
}

/**
 * Check if an artifact type has a props schema defined.
 */
export function hasPropsSchema(type: string): boolean {
  return type in ARTIFACT_PROPS_SCHEMAS;
}

/**
 * Get list of artifact types that have props schemas.
 */
export function getTypesWithPropsSchemas(): string[] {
  return Object.keys(ARTIFACT_PROPS_SCHEMAS);
}
