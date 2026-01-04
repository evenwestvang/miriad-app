/**
 * Raw Anthropic API Agent Handler
 *
 * A Lambda-native agent implementation using the Anthropic SDK directly,
 * bypassing the Claude Agent SDK which requires the CLI subprocess.
 *
 * This provides a working sandbox agent with basic tools:
 * - read_file: Read file contents
 * - write_file: Write/create files
 * - run_bash: Execute shell commands
 * - list_files: List directory contents
 *
 * Emits Tymbal protocol messages (see spec/Tymbal.md and spec/design.md):
 * - type: "tool_call" - When a tool is invoked (with id, name, args)
 * - type: "tool_result" - Tool execution result (with call_id, content)
 * - type: "assistant" - Assistant text responses
 * - type: "agent_complete" - When the agent turn completes
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  getThreadHistory,
  getThreadMeta,
  persistMessage,
  updateThreadMeta,
} from "../../shared/db.js";
import { broadcast, hasListeners } from "../../shared/broadcast.js";
import { tymbal } from "@cikada/core/tymbal";
import { generateMessageId } from "../../shared/ulid.js";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// =============================================================================
// Types
// =============================================================================

export interface RawAgentEvent {
  threadId: string;
  workdirBase: string;
}

interface StoredMessage {
  msgId: string;
  value: {
    type: string;
    content?: string;
    role?: string;
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the specified path",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The path to the file to read (relative to workdir)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file at the specified path",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The path to the file to write (relative to workdir)",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_bash",
    description: "Execute a bash command in the workdir",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories at the specified path",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The directory path to list (relative to workdir, defaults to '.')",
        },
      },
      required: [],
    },
  },
];

// =============================================================================
// Tool Execution
// =============================================================================

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  workdir: string
): Promise<string> {
  const resolvePath = (p: string) => {
    const resolved = path.resolve(workdir, p);
    // Security: ensure path is within workdir
    if (!resolved.startsWith(workdir)) {
      throw new Error(`Path escapes workdir: ${p}`);
    }
    return resolved;
  };

  switch (toolName) {
    case "read_file": {
      const filePath = resolvePath(toolInput.path as string);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return content;
      } catch (error) {
        return `Error reading file: ${(error as Error).message}`;
      }
    }

    case "write_file": {
      const filePath = resolvePath(toolInput.path as string);
      const content = toolInput.content as string;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return `Successfully wrote ${content.length} bytes to ${toolInput.path}`;
      } catch (error) {
        return `Error writing file: ${(error as Error).message}`;
      }
    }

    case "run_bash": {
      const command = toolInput.command as string;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workdir,
          timeout: 30000, // 30s timeout
          maxBuffer: 1024 * 1024, // 1MB output limit
        });
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        return output || "(no output)";
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; message: string };
        return `Error: ${err.message}\n${err.stdout || ""}${err.stderr || ""}`;
      }
    }

    case "list_files": {
      const dirPath = resolvePath((toolInput.path as string) || ".");
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const listing = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n");
        return listing || "(empty directory)";
      } catch (error) {
        return `Error listing directory: ${(error as Error).message}`;
      }
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// =============================================================================
// Main Agent Loop
// =============================================================================

export async function runRawAgent(event: RawAgentEvent): Promise<void> {
  const { threadId, workdirBase } = event;
  const startTime = Date.now();
  let numTurns = 0;

  console.log(`[Raw Agent] Starting for thread ${threadId}`);

  // Ensure workdir exists
  const workdir = path.join(workdirBase, "workdirs", threadId);
  await fs.mkdir(workdir, { recursive: true });
  console.log(`[Raw Agent] Workdir: ${workdir}`);

  // Update thread status
  await updateThreadMeta(threadId, { status: "running" });

  // Initialize Anthropic client
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Load thread history and convert to Anthropic message format
  const history = (await getThreadHistory(threadId)) as unknown as StoredMessage[];
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of history) {
    if (msg.value.type === "user") {
      messages.push({
        role: "user",
        content: msg.value.content || "",
      });
    } else if (msg.value.type === "assistant") {
      messages.push({
        role: "assistant",
        content: msg.value.content || "",
      });
    }
  }

  console.log(`[Raw Agent] Loaded ${messages.length} messages from history`);

  // Check for listeners for streaming
  const shouldStream = await hasListeners(threadId);

  try {
    // Agentic loop - continue until no more tool calls
    let continueLoop = true;

    while (continueLoop) {
      numTurns++;
      console.log(`[Raw Agent] Turn ${numTurns}`);

      // Call Claude
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: `You are a helpful coding assistant with access to a sandboxed workspace.
You can read and write files, run bash commands, and list directory contents.
The workspace is at: ${workdir}
Be concise and helpful. When asked to do something, just do it - don't explain unless asked.`,
        tools,
        messages,
      });

      console.log(`[Raw Agent] Response stop_reason: ${response.stop_reason}`);

      // Process response content blocks
      const assistantContent: Anthropic.ContentBlock[] = [];
      let textContent = "";
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of response.content) {
        assistantContent.push(block);

        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });

          // Emit tool_call event
          const tcMsgId = generateMessageId();
          const tcValue = {
            type: "tool_call",
            id: block.id,
            name: block.name,
            args: block.input,
          };
          await persistMessage(threadId, tcMsgId, tcValue);
          if (shouldStream) {
            await broadcast(threadId, tymbal.set(tcMsgId, tcValue));
          }
        }
      }

      // Persist and broadcast assistant text if any
      if (textContent) {
        const msgId = generateMessageId();
        await persistMessage(threadId, msgId, {
          type: "assistant",
          content: textContent,
        });
        if (shouldStream) {
          await broadcast(threadId, tymbal.set(msgId, {
            type: "assistant",
            content: textContent,
          }));
        }
      }

      // Add assistant message to history
      messages.push({
        role: "assistant",
        content: assistantContent,
      });

      // Check if we should continue (tool use)
      if (response.stop_reason === "tool_use" && toolUses.length > 0) {
        // Execute tools and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const tool of toolUses) {
          console.log(`[Raw Agent] Executing tool: ${tool.name}`);
          const toolStartTime = Date.now();

          const result = await executeTool(tool.name, tool.input, workdir);

          const elapsed = (Date.now() - toolStartTime) / 1000;
          console.log(`[Raw Agent] Tool ${tool.name} completed in ${elapsed.toFixed(1)}s`);

          // Emit tool_result as a full Tymbal message (per spec/design.md)
          const resultMsgId = generateMessageId();
          const resultValue = {
            type: "tool_result",
            call_id: tool.id,
            name: tool.name,
            content: result,
            durationMs: Math.round(elapsed * 1000),
          };
          await persistMessage(threadId, resultMsgId, resultValue);
          if (shouldStream) {
            await broadcast(threadId, tymbal.set(resultMsgId, resultValue));
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: result,
          });
        }

        // Add tool results to messages
        messages.push({
          role: "user",
          content: toolResults,
        });
      } else {
        // No more tool calls - exit loop
        continueLoop = false;
      }

      // Safety limit
      if (numTurns >= 20) {
        console.log("[Raw Agent] Hit turn limit, stopping");
        continueLoop = false;
      }
    }

    // Emit completion event
    const durationMs = Date.now() - startTime;
    const completeMsgId = generateMessageId();
    const completeValue = {
      type: "agent_complete",
      status: "success",
      durationMs,
      numTurns,
    };
    await persistMessage(threadId, completeMsgId, completeValue);
    if (shouldStream) {
      await broadcast(threadId, tymbal.set(completeMsgId, completeValue));
    }

    console.log(`[Raw Agent] Completed in ${durationMs}ms, ${numTurns} turns`);
  } catch (error) {
    console.error("[Raw Agent] Error:", error);

    // Emit error event
    const errorMsgId = generateMessageId();
    const errorValue = {
      type: "agent_complete",
      status: "error",
      message: (error as Error).message || "Unknown error",
    };
    await persistMessage(threadId, errorMsgId, errorValue);
    if (shouldStream) {
      await broadcast(threadId, tymbal.set(errorMsgId, errorValue));
    }
  } finally {
    // Update thread status
    await updateThreadMeta(threadId, { status: "waiting" });
  }
}

/**
 * Create handler for raw agent Lambda.
 */
export function createRawAgentHandler() {
  return async (event: RawAgentEvent): Promise<void> => {
    await runRawAgent(event);
  };
}
