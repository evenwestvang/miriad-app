/**
 * Artifact Props Schemas
 *
 * Zod schemas for validating artifact props fields.
 * Used for:
 * - Runtime validation in storage layer
 * - JSON Schema generation for MCP tools (explain_artifact_type)
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// =============================================================================
// system.mcp props schema
// =============================================================================

/**
 * MCP reference in system.agent props.
 * References a system.mcp artifact by slug.
 */
export const McpReferenceSchema = z.object({
  slug: z.string().describe('Slug of the system.mcp artifact to use'),
});

export type McpReference = z.infer<typeof McpReferenceSchema>;

/**
 * OAuth configuration for HTTP MCP servers (user-specified overrides only).
 *
 * Props store manual overrides (user config). Dynamic registration credentials
 * and tokens are stored in artifact secrets:
 * - oauth_access_token
 * - oauth_refresh_token
 * - oauth_client_id (from dynamic registration)
 * - oauth_client_secret (from dynamic registration, if server returns one)
 */
export const OAuthConfigSchema = z.object({
  type: z.literal('oauth').describe('OAuth authentication type'),
  authorizationEndpoint: z
    .string()
    .url()
    .optional()
    .describe('Manual override for authorization endpoint (auto-discovered if not set)'),
  tokenEndpoint: z
    .string()
    .url()
    .optional()
    .describe('Manual override for token endpoint (auto-discovered if not set)'),
  clientId: z
    .string()
    .optional()
    .describe('Manual client ID (skips dynamic registration if set)'),
  scopes: z
    .array(z.string())
    .optional()
    .describe('OAuth scopes to request'),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

/**
 * Schema for system.mcp artifact props.
 * Defines MCP server configuration for stdio or http transports.
 */
export const SystemMcpPropsSchema = z
  .object({
    transport: z.enum(['stdio', 'http']).describe('Transport type for the MCP server'),

    // stdio transport fields
    command: z
      .string()
      .optional()
      .describe("Command to execute for stdio transport (e.g., 'npx', 'node')"),
    args: z
      .array(z.string())
      .optional()
      .describe('Arguments to pass to the command'),
    variables: z
      .record(z.string())
      .optional()
      .describe('Environment variables. Use ${VAR_NAME} syntax to reference shared environment'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory for the command'),

    // http transport fields
    url: z
      .string()
      .url()
      .optional()
      .describe('URL for HTTP transport MCP server'),

    // OAuth configuration for http transport (tokens stored in secrets)
    oauth: OAuthConfigSchema.optional().describe(
      'OAuth 2.1 configuration for HTTP MCP servers. Tokens are stored encrypted in artifact secrets.'
    ),

    // Description field
    capabilities: z
      .string()
      .optional()
      .describe('Human-readable description of what this MCP server provides'),
  })
  .superRefine((data, ctx) => {
    // Transport-specific field validation
    if (data.transport === 'stdio' && !data.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio transport requires 'command'",
        path: ['command'],
      });
    }
    if (data.transport === 'http' && !data.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http transport requires 'url'",
        path: ['url'],
      });
    }
  });

export type SystemMcpProps = z.infer<typeof SystemMcpPropsSchema>;

// =============================================================================
// system.agent props schema
// =============================================================================

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
    .describe('Name theme for generating agent callsigns'),
  agentName: z
    .string()
    .optional()
    .describe('Fixed agent name (for singleton agents)'),
  mcp: z
    .array(McpReferenceSchema)
    .optional()
    .describe('List of MCP servers to provide to this agent'),
  featuredChannelStarter: z
    .boolean()
    .optional()
    .describe('Show this agent as a suggested starter when creating new channels'),
});

export type SystemAgentProps = z.infer<typeof SystemAgentPropsSchema>;

// =============================================================================
// system.focus props schema
// =============================================================================

/**
 * Schema for system.focus artifact props.
 * Defines a focus (channel template) with required agents and optional defaults.
 */
export const SystemFocusPropsSchema = z.object({
  agents: z
    .array(z.string())
    .min(1)
    .describe('Array of system.agent slugs that will be spawned when a channel uses this focus'),
  defaultTagline: z
    .string()
    .optional()
    .describe('Default tagline for channels created with this focus'),
  defaultMission: z
    .string()
    .optional()
    .describe('Default mission statement for channels created with this focus'),
  initialPrompt: z
    .string()
    .optional()
    .describe('Initial prompt sent to agents when channel is created'),
});

export type SystemFocusProps = z.infer<typeof SystemFocusPropsSchema>;

// =============================================================================
// system.environment props schema
// =============================================================================

/**
 * Schema for system.environment artifact props.
 * Defines environment variables for agents. Secrets use the existing
 * artifact secrets facility (stored encrypted, values never returned).
 */
export const SystemEnvironmentPropsSchema = z.object({
  variables: z
    .record(z.string())
    .default({})
    .describe('Plaintext environment variables (key-value pairs)'),
});

export type SystemEnvironmentProps = z.infer<typeof SystemEnvironmentPropsSchema>;

// =============================================================================
// Schema Registry
// =============================================================================

/**
 * Registry of Zod schemas for artifact props by type.
 * Used for validation and JSON Schema generation.
 */
export const ARTIFACT_PROPS_SCHEMAS: Record<string, z.ZodSchema> = {
  'system.mcp': SystemMcpPropsSchema,
  'system.agent': SystemAgentPropsSchema,
  'system.focus': SystemFocusPropsSchema,
  'system.environment': SystemEnvironmentPropsSchema,
};

/**
 * List of artifact types that have props schemas.
 */
export const SYSTEM_ARTIFACT_TYPES = Object.keys(ARTIFACT_PROPS_SCHEMAS);

/**
 * All artifact types that have props schemas defined.
 * For full artifact type list, see ArtifactType in types.ts.
 */
export const PROPS_SCHEMA_TYPES = ['system.agent', 'system.environment', 'system.focus', 'system.mcp'] as const;

export type PropsSchemaType = (typeof PROPS_SCHEMA_TYPES)[number];

// =============================================================================
// JSON Schema Conversion
// =============================================================================

/**
 * Get JSON Schema for a specific artifact type's props.
 * Returns null if no schema is defined for the type.
 */
export function getJsonSchema(type: string): object | null {
  const schema = ARTIFACT_PROPS_SCHEMAS[type];
  if (!schema) return null;
  // Use target: 'jsonSchema7' and no name for a flat schema without definitions
  const result = zodToJsonSchema(schema, {
    $refStrategy: 'none', // Inline all refs for simpler schema
  }) as Record<string, unknown>;
  // Remove $schema key to keep output clean
  delete result.$schema;
  return result;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validation result with structured details.
 */
export interface PropsValidationResult {
  valid: boolean;
  errors?: Array<{
    path: string;
    message: string;
    received?: unknown;
  }>;
}

/**
 * Validate props for a given artifact type.
 * Returns validation result with errors if invalid.
 */
export function validateArtifactProps(
  type: string,
  props: unknown
): PropsValidationResult {
  const schema = ARTIFACT_PROPS_SCHEMAS[type];
  if (!schema) {
    // No schema defined for this type - no validation required
    return { valid: true };
  }

  const result = schema.safeParse(props);
  if (result.success) {
    return { valid: true };
  }

  // Build structured error
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    received: issue.code === 'invalid_type' ? (issue as { received?: unknown }).received : undefined,
  }));

  return { valid: false, errors };
}

/**
 * Validate props and throw if invalid.
 * Use this for synchronous validation in store operations.
 */
export function assertValidProps(type: string, props: unknown): void {
  const result = validateArtifactProps(type, props);
  if (!result.valid && result.errors) {
    const errorLines = result.errors
      .map((e) => `  - ${e.path}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid props for ${type}:\n${errorLines}`);
  }
}
