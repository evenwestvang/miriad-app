import type {
  AgentDefinition,
  DefineAgentOptions,
  WorkflowDefinition,
  DefineWorkflowOptions,
  ToolDefinition,
} from "./types.js";

// Re-export types
export type {
  AgentConfig,
  AgentDefinition,
  AgentHandle,
  AgentMessage,
  ContentBlock,
  Context,
  DefineAgentOptions,
  DefineWorkflowOptions,
  FlowEvent,
  GenerateResult,
  Message,
  MessageHandle,
  ProcessDefinition,
  SentMessage,
  StepOptions,
  StepResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
  WorkflowDefinition,
} from "./types.js";

// Re-export defineTool from types (it has the proper implementation)
export { defineTool } from "./types.js";

/**
 * Define an agent - long-lived, event-driven.
 *
 * Agents handle messages as they arrive, potentially forever.
 * They remain open for new messages until explicitly completed.
 *
 * The simplest agent just needs a system prompt:
 * ```ts
 * const agent = defineAgent({
 *   system: "You are a helpful assistant.",
 * });
 * ```
 *
 * Add tools to give the agent capabilities:
 * ```ts
 * const agent = defineAgent({
 *   system: "You help users check the weather.",
 *   tools: {
 *     get_weather: {
 *       description: "Get current weather for a location",
 *       parameters: z.object({ location: z.string() }),
 *       execute: async ({ location }) => fetchWeather(location),
 *     },
 *   },
 * });
 * ```
 *
 * For custom behavior, add an onEvent handler:
 * ```ts
 * const agent = defineAgent({
 *   system: "You are a helpful assistant.",
 *   onEvent: async (event, ctx) => {
 *     if (event.type === "message") {
 *       await ctx.llm.generate(event.content);
 *     }
 *   },
 * });
 * ```
 */
export function defineAgent<TTools extends Record<string, ToolDefinition>>(
  options: DefineAgentOptions<TTools>
): AgentDefinition<TTools> {
  return {
    kind: "agent",
    name: options.name,
    system: options.system,
    config: options.config,
    tools: options.tools,
    onEvent: options.onEvent,
  };
}

/**
 * Define a workflow - structured, goal-oriented.
 *
 * Workflows progress through stages toward a final result.
 * They complete when onFlow returns.
 *
 * ```ts
 * const workflow = defineWorkflow({
 *   system: "You research topics thoroughly.",
 *   onFlow: async (ctx) => {
 *     const request = await ctx.events.next();
 *     const result = await ctx.llm.generate(request.content);
 *     return { findings: result.text };
 *   },
 * });
 * ```
 *
 * With tools:
 * ```ts
 * const workflow = defineWorkflow({
 *   system: "You research and summarize.",
 *   tools: {
 *     search: {
 *       description: "Search the web",
 *       parameters: z.object({ query: z.string() }),
 *       execute: async ({ query }) => webSearch(query),
 *     },
 *   },
 *   onFlow: async (ctx) => {
 *     const request = await ctx.events.next();
 *     const result = await ctx.llm.generate(`Research: ${request.content}`);
 *     return { findings: result.text };
 *   },
 * });
 * ```
 */
export function defineWorkflow<
  TTools extends Record<string, ToolDefinition>,
  TResult = unknown
>(
  options: DefineWorkflowOptions<TTools, TResult>
): WorkflowDefinition<TTools, TResult> {
  return {
    kind: "workflow",
    name: options.name,
    system: options.system,
    config: options.config,
    tools: options.tools,
    onFlow: options.onFlow,
  };
}
