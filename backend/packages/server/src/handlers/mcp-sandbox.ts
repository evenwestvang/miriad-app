/**
 * Sandbox MCP HTTP Transport Handler (JSON-RPC)
 *
 * Serves Daytona sandbox tools via MCP HTTP transport.
 * Separate MCP server from the main miriad tools — agents see these
 * as sandbox__create, sandbox__Read, etc.
 *
 * Endpoint:
 * - POST /mcp-sandbox/:channel - JSON-RPC endpoint for sandbox tools
 *
 * Auth: Same channel bearer token as the main miriad MCP.
 * Env: Resolved from channel's system.environment artifacts (same path as agent delivery).
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import {
  requireContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from '../auth/container-middleware.js';
import {
  getWrappedTools,
  createSandboxContext,
  type SandboxContext,
  type ToolResult,
  type Daytona,
} from '@cast/sandbox-mcp';

// =============================================================================
// JSON-RPC helpers
// =============================================================================

const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function jsonRpcSuccess(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// =============================================================================
// Types
// =============================================================================

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface SandboxMcpOptions {
  storage: Storage;
  /** Daytona client singleton — created once at server startup */
  daytona: Daytona;
  /** Resolve channel environment (secrets decrypted). Same code path as agent delivery. */
  resolveEnvironment: (spaceId: string, channelId: string) => Promise<Record<string, string>>;
}

// =============================================================================
// Route factory
// =============================================================================

export function createSandboxMcpRoutes(options: SandboxMcpOptions) {
  const { storage, daytona, resolveEnvironment } = options;
  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Auth middleware — same as main miriad MCP
  app.use('/:channel', requireContainerAuth());

  // Get wrapped tools once (tool definitions are static)
  const wrappedTools = getWrappedTools();

  // Build MCP tool definitions from Zod schemas
  const toolDefinitions: McpToolDefinition[] = wrappedTools.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  }));

  // Build handler lookup
  const toolHandlers = new Map<string, (ctx: SandboxContext, args: any) => Promise<ToolResult>>();
  for (const t of wrappedTools) {
    toolHandlers.set(t.name, t.handler);
  }

  // POST /mcp/sandbox/:channel — JSON-RPC endpoint
  app.post('/:channel', async (c) => {
    const container = getContainerAuth(c);
    if (!container) {
      return c.json(jsonRpcError(null, JSONRPC_ERRORS.INTERNAL_ERROR, 'Auth context missing'), 401);
    }

    const { spaceId, channelId, callsign } = container;

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, JSONRPC_ERRORS.PARSE_ERROR, 'Parse error'));
    }

    const request = body as {
      jsonrpc: string;
      id: string | number | null;
      method: string;
      params?: unknown;
    };

    if (request.jsonrpc !== '2.0' || !request.method) {
      return c.json(jsonRpcError(request?.id ?? null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request'));
    }

    switch (request.method) {
      case 'initialize': {
        return c.json(jsonRpcSuccess(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sandbox', version: '0.1.0' },
        }));
      }

      case 'notifications/initialized': {
        // JSON-RPC notifications have no id and expect no response,
        // but MCP clients send this as a regular request. Return empty result.
        return c.json(jsonRpcSuccess(request.id, {}));
      }

      case 'tools/list': {
        return c.json(jsonRpcSuccess(request.id, { tools: toolDefinitions }));
      }

      case 'tools/call': {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;

        if (!params?.name) {
          return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.INVALID_PARAMS, 'Missing tool name'));
        }

        const handler = toolHandlers.get(params.name);
        if (!handler) {
          return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${params.name}`));
        }

        try {
          // Resolve channel environment (secrets decrypted)
          const env = await resolveEnvironment(spaceId, channelId);

          // Extract git credentials from resolved env
          const git = {
            token: env.GITHUB_TOKEN || env.GIT_TOKEN || env.GITHUB_PERSONAL_ACCESS_TOKEN,
            username: env.GIT_USERNAME || 'oauth2',
          };

          // Create per-request sandbox context
          const ctx = createSandboxContext({
            daytona,
            channelId,
            spaceId,
            callsign,
            env,
            git,
          });

          const result = await handler(ctx, params.arguments ?? {});
          return c.json(jsonRpcSuccess(request.id, result));
        } catch (err) {
          return c.json(jsonRpcSuccess(request.id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }));
        }
      }

      default: {
        return c.json(jsonRpcError(request.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${request.method}`));
      }
    }
  });

  return app;
}

// =============================================================================
// Zod → JSON Schema conversion (minimal, for tool definitions)
// =============================================================================

function zodToJsonSchema(schema: any): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  // Zod schemas have a _def property with shape info
  const def = schema._def;
  if (!def || def.typeName !== 'ZodObject') {
    return { type: 'object', properties: {} };
  }

  const shape = def.shape();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape) as [string, any][]) {
    const fieldDef = fieldSchema._def;
    const isOptional = fieldDef.typeName === 'ZodOptional';
    const innerDef = isOptional ? fieldDef.innerType._def : fieldDef;

    const prop: Record<string, unknown> = {};

    switch (innerDef.typeName) {
      case 'ZodString':
        prop.type = 'string';
        break;
      case 'ZodNumber':
        prop.type = 'number';
        break;
      case 'ZodBoolean':
        prop.type = 'boolean';
        break;
      case 'ZodEnum':
        prop.type = 'string';
        prop.enum = innerDef.values;
        break;
      case 'ZodArray':
        prop.type = 'array';
        prop.items = { type: 'string' }; // simplified
        break;
      case 'ZodRecord':
        prop.type = 'object';
        prop.additionalProperties = { type: 'string' };
        break;
      default:
        prop.type = 'string';
    }

    // Extract description from Zod .describe()
    const description = isOptional
      ? fieldDef.innerType._def.description
      : fieldDef.description;
    if (description) {
      prop.description = description;
    }

    properties[key] = prop;
    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
