/**
 * Reactive Agent Core Loop
 *
 * Stateless agentic loop that:
 * 1. Takes conversation history as input (no fetching)
 * 2. Runs LLM with streaming output
 * 3. Executes tool calls
 * 4. Broadcasts Tymbal frames (persistence handled server-side)
 *
 * The reactive agent is stateless - caller provides the conversation history.
 * Persistence is handled by the server when it receives Tymbal frames.
 */

import type { LLMMessage, LLMContentBlock, ToolDefinition } from "./adapters/llm.js";
import type {
  ReactiveAgentConfig,
  ReactiveAgentResult,
  ToolCall,
  StepResult,
} from "./types.js";
import { tymbal, createMessageHandle, generateMessageId } from "@cikada/core/tymbal";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 4096;

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Run a single turn of the reactive agent.
 *
 * A "turn" from the user's perspective can involve many LLM calls internally:
 * User message → [LLM → tool → LLM → tool → ...] → Final response
 *
 * This function handles the entire agentic loop until the LLM produces a
 * final response without tool calls.
 */
export async function runReactiveAgent(
  config: ReactiveAgentConfig
): Promise<ReactiveAgentResult> {
  const {
    spaceId,
    channelId,
    agentCallsign,
    userMessage,
    systemPrompt,
    conversationHistory,
    broadcast,
    llm,
    tools,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    maxTurns = DEFAULT_MAX_TURNS,
  } = config;

  const startTime = Date.now();
  const messageIds: string[] = [];
  let numTurns = 0;
  let finalResponse = "";

  // Generate a unique turnId for this entire agentic loop invocation
  // This allows server-side grouping of all messages from one turn
  const turnId = generateMessageId();

  console.log(
    `[ReactiveAgent] Starting for ${agentCallsign} in channel ${channelId}`
  );

  try {
    // -------------------------------------------------------------------------
    // 1. Use provided conversation history (reactive agent is stateless)
    // -------------------------------------------------------------------------

    // Copy the provided history and add the new user message
    const messages: LLMMessage[] = [...conversationHistory];
    messages.push({
      role: "user",
      content: userMessage,
    });

    // -------------------------------------------------------------------------
    // 2. Get available tools
    // -------------------------------------------------------------------------

    let toolDefinitions: ToolDefinition[] | undefined;
    if (tools) {
      toolDefinitions = await tools.getTools();
      console.log(`[ReactiveAgent] Loaded ${toolDefinitions.length} tools`);
    }

    // -------------------------------------------------------------------------
    // 3. Agentic loop
    // -------------------------------------------------------------------------

    let continueLoop = true;

    while (continueLoop && numTurns < maxTurns) {
      numTurns++;
      console.log(`[ReactiveAgent] Turn ${numTurns}`);

      // Generate response from LLM
      const stepResult = await generateStep({
        llm,
        model,
        systemPrompt,
        messages,
        tools: toolDefinitions,
        maxTokens,
        agentCallsign,
        turnId,
        broadcast: broadcast.broadcast.bind(broadcast),
      });

      // Build assistant content for conversation history
      // This includes both text and tool_use blocks in a single message
      const assistantContent: LLMContentBlock[] = [];
      if (stepResult.text) {
        assistantContent.push({ type: "text", text: stepResult.text });
        finalResponse = stepResult.text;
      }
      for (const call of stepResult.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args,
        });
      }

      // Add assistant content to conversation history
      // Note: Persistence is handled server-side when Tymbal frames are received
      if (assistantContent.length > 0) {
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
      }

      // Handle tool calls
      if (stepResult.stopReason === "tool_use" && stepResult.toolCalls.length > 0) {
        const toolResultBlocks: LLMContentBlock[] = [];

        for (const call of stepResult.toolCalls) {
          console.log(`[ReactiveAgent] Executing tool: ${call.name}`);

          // Broadcast tool call for UI display
          // Note: Persistence is handled server-side when Tymbal frames are received
          const tcMsgId = generateMessageId();
          await broadcast.broadcast(
            tymbal.set(tcMsgId, {
              type: "tool_call",
              id: call.id,
              name: call.name,
              args: call.args,
              sender: agentCallsign,
              turnId,
            })
          );

          // Execute tool
          let result: unknown;
          let isError = false;

          if (tools) {
            try {
              const toolResult = await tools.execute(call.name, call.args, {
                spaceId,
                channelId,
                agentCallsign,
              });
              result = toolResult.content;
              isError = toolResult.isError;
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          } else {
            result = `Tool execution not available: ${call.name}`;
            isError = true;
          }

          // Broadcast tool result
          // Note: Persistence is handled server-side when Tymbal frames are received
          const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? null);
          const trMsgId = generateMessageId();
          await broadcast.broadcast(
            tymbal.set(trMsgId, {
              type: "tool_result",
              call_id: call.id,
              name: call.name,
              content: resultStr,
              isError,
              sender: agentCallsign,
              turnId,
            })
          );
          messageIds.push(trMsgId);

          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: resultStr,
          });
        }

        // Add tool results to conversation
        messages.push({
          role: "user",
          content: toolResultBlocks,
        });
      } else {
        // No more tool calls - exit loop
        continueLoop = false;
      }
    }

    // -------------------------------------------------------------------------
    // 4. Finalize
    // -------------------------------------------------------------------------

    const durationMs = Date.now() - startTime;
    console.log(`[ReactiveAgent] Completed in ${durationMs}ms, ${numTurns} turns`);

    // Broadcast completion
    const completeMsgId = generateMessageId();
    await broadcast.broadcast(
      tymbal.set(completeMsgId, {
        type: "agent_complete",
        status: "success",
        durationMs,
        numTurns,
        sender: agentCallsign,
        turnId,
      })
    );

    return {
      response: finalResponse,
      numTurns,
      durationMs,
      messageIds,
    };
  } catch (error) {
    console.error("[ReactiveAgent] Error:", error);

    // Broadcast error
    // Note: Persistence is handled server-side when Tymbal frames are received
    const errorMsgId = generateMessageId();
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await broadcast.broadcast(
      tymbal.set(errorMsgId, {
        type: "agent_complete",
        status: "error",
        message: errorMessage,
        sender: agentCallsign,
        turnId,
      })
    );

    throw error;
  } finally {
    // Clean up tool adapter resources
    if (tools?.cleanup) {
      try {
        await tools.cleanup();
      } catch (err) {
        console.warn("[ReactiveAgent] Tool cleanup error:", err);
      }
    }
  }
}

// =============================================================================
// LLM Generation Step
// =============================================================================

interface GenerateStepParams {
  llm: ReactiveAgentConfig["llm"];
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  maxTokens: number;
  agentCallsign: string;
  turnId: string;
  broadcast: (frame: string) => Promise<void>;
}

/**
 * Execute a single LLM generation step with streaming.
 */
async function generateStep(params: GenerateStepParams): Promise<StepResult> {
  const {
    llm,
    model,
    systemPrompt,
    messages,
    tools,
    maxTokens,
    agentCallsign,
    turnId,
    broadcast,
  } = params;

  // Create message handle for streaming
  const msgId = generateMessageId();
  const msgHandle = createMessageHandle({
    id: msgId,
    metadata: { type: "assistant", sender: agentCallsign, turnId },
    broadcast,
  });

  let textContent = "";
  const toolCalls: ToolCall[] = [];
  let stopReason: StepResult["stopReason"] = "end_turn";

  // Track tool calls being built during streaming
  const toolCallsInProgress = new Map<
    number,
    { id: string; name: string; inputJson: string }
  >();

  // Stream from LLM
  for await (const chunk of llm.stream({
    model,
    system: systemPrompt,
    messages,
    tools,
    max_tokens: maxTokens,
  })) {
    if (chunk.type === "text") {
      textContent += chunk.content;
      await msgHandle.stream(chunk.content);
    } else if (chunk.type === "tool_use") {
      toolCalls.push({
        id: chunk.toolCall.id,
        name: chunk.toolCall.name,
        args: chunk.toolCall.input,
      });
    } else if (chunk.type === "content_block_start") {
      if (chunk.contentBlock.type === "tool_use" && chunk.contentBlock.id) {
        toolCallsInProgress.set(chunk.index, {
          id: chunk.contentBlock.id,
          name: chunk.contentBlock.name || "",
          inputJson: "",
        });
      }
    } else if (chunk.type === "content_block_delta") {
      // Only handle input_json_delta for tool arguments here.
      // Text deltas are handled via the normalized "text" chunk type above
      // to avoid double-processing when adapters emit both formats.
      if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
        const toolCall = toolCallsInProgress.get(chunk.index);
        if (toolCall) {
          toolCall.inputJson += chunk.delta.partial_json;
        }
      }
    } else if (chunk.type === "content_block_stop") {
      const toolCall = toolCallsInProgress.get(chunk.index);
      if (toolCall) {
        try {
          const input = JSON.parse(toolCall.inputJson || "{}");
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            args: input,
          });
        } catch {
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            args: {},
          });
        }
        toolCallsInProgress.delete(chunk.index);
      }
    } else if (chunk.type === "message_delta") {
      stopReason = chunk.stopReason;
    }
  }

  // Finalize the streamed message
  if (textContent) {
    await msgHandle.set({
      type: "assistant",
      sender: agentCallsign,
      content: textContent,
      turnId,
    });
  }

  return {
    text: textContent,
    toolCalls,
    stopReason,
  };
}
