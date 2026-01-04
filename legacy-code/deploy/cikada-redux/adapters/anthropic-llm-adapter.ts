/**
 * Anthropic LLM Adapter (Lambda)
 *
 * Wraps the Anthropic SDK to implement the LLMAdapter interface
 * from @cikada/reactive-agent. Same implementation as local-runtime
 * but configured for Lambda environment.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMAdapter,
  LLMStreamParams,
  StreamChunk,
} from "@cikada/reactive-agent";

// =============================================================================
// Anthropic Adapter
// =============================================================================

export interface AnthropicAdapterOptions {
  /** Anthropic client instance */
  client: Anthropic;
}

/**
 * LLM adapter that wraps the Anthropic SDK.
 * Implements the LLMAdapter interface from @cikada/reactive-agent.
 */
export class AnthropicLLMAdapter implements LLMAdapter {
  private client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    this.client = options.client;
  }

  /**
   * Stream a response from Claude.
   */
  async *stream(params: LLMStreamParams): AsyncIterable<StreamChunk> {
    const { model, system, messages, tools, max_tokens } = params;

    // Convert messages to Anthropic format
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content as string | Anthropic.ContentBlock[],
    }));

    // Convert tools to Anthropic format
    const anthropicTools: Anthropic.Tool[] | undefined = tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    }));

    // Create streaming request
    const stream = this.client.messages.stream({
      model,
      max_tokens: max_tokens ?? 4096,
      system: system ?? "",
      messages: anthropicMessages,
      tools: anthropicTools,
    });

    // Track tool calls being built
    const toolCallsInProgress: Map<
      number,
      { id: string; name: string; inputJson: string }
    > = new Map();

    // Process stream events
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        // Yield raw content_block_start for consumers that need it
        yield {
          type: "content_block_start",
          index: event.index,
          contentBlock: {
            type: event.content_block.type,
            id: event.content_block.type === "tool_use" ? event.content_block.id : undefined,
            name: event.content_block.type === "tool_use" ? event.content_block.name : undefined,
          },
        };

        if (event.content_block.type === "tool_use") {
          // Start tracking a new tool call
          toolCallsInProgress.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          // Yield both formats for compatibility
          yield { type: "text", content: event.delta.text };
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "text_delta", text: event.delta.text },
          };
        } else if (event.delta.type === "input_json_delta") {
          // Accumulate tool input JSON
          const toolCall = toolCallsInProgress.get(event.index);
          if (toolCall) {
            toolCall.inputJson += event.delta.partial_json;
          }
          yield {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: event.delta.partial_json },
          };
        }
      } else if (event.type === "content_block_stop") {
        // Yield raw content_block_stop
        yield { type: "content_block_stop", index: event.index };

        // Check if this was a tool call block
        const toolCall = toolCallsInProgress.get(event.index);
        if (toolCall) {
          // Parse the accumulated JSON and yield the tool call
          try {
            const input = JSON.parse(toolCall.inputJson || "{}");
            yield {
              type: "tool_use",
              toolCall: {
                id: toolCall.id,
                name: toolCall.name,
                input,
              },
            };
          } catch {
            // If JSON parsing fails, yield with empty input
            yield {
              type: "tool_use",
              toolCall: {
                id: toolCall.id,
                name: toolCall.name,
                input: {},
              },
            };
          }
          toolCallsInProgress.delete(event.index);
        }
      } else if (event.type === "message_delta") {
        // Yield stop reason
        if (event.delta.stop_reason === "tool_use") {
          yield { type: "message_delta", stopReason: "tool_use" };
        } else if (event.delta.stop_reason === "max_tokens") {
          yield { type: "message_delta", stopReason: "max_tokens" };
        } else if (event.delta.stop_reason === "end_turn") {
          yield { type: "message_delta", stopReason: "end_turn" };
        } else if (event.delta.stop_reason === "stop_sequence") {
          yield { type: "message_delta", stopReason: "stop_sequence" };
        }
      }
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Anthropic client singleton for Lambda warm starts.
 */
let clientInstance: Anthropic | null = null;

/**
 * Get or create the Anthropic client singleton.
 */
function getClient(): Anthropic {
  if (!clientInstance) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set");
    }
    clientInstance = new Anthropic({ apiKey });
  }
  return clientInstance;
}

/**
 * Create an Anthropic LLM adapter using environment config.
 */
export function createAnthropicAdapter(): AnthropicLLMAdapter {
  return new AnthropicLLMAdapter({ client: getClient() });
}

/**
 * Create an Anthropic LLM adapter from an existing client.
 */
export function createAnthropicAdapterFromClient(client: Anthropic): AnthropicLLMAdapter {
  return new AnthropicLLMAdapter({ client });
}
