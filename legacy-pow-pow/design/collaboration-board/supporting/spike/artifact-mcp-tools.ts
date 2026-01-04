/**
 * SPIKE: Artifact MCP Tools
 *
 * This file contains the MCP tool definitions for the artifact system.
 * To integrate: add these tool definitions to createMcpServer() in src/server/index.ts
 *
 * Dependencies:
 * - store.createOrUpdateArtifact()
 * - store.getArtifact()
 * - store.listArtifacts()
 * - store.archiveArtifact()
 * - Artifact type from store.ts
 */

import { z } from "zod";

// Zod schemas for validation
const ArtifactStatusSchema = z.enum(["draft", "published", "archived"]).optional();
const TaskStatusSchema = z.enum(["pending", "in_progress", "done", "blocked"]).optional();

/**
 * Tool: publish_artifact
 * Create or update an artifact (upsert semantics)
 */
export const publishArtifactTool = {
  name: "publish_artifact",
  description: `Create or update a named artifact in a channel. Artifacts are persistent objects that outlive chat messages - use them for specs, decisions, tasks, and other durable outputs.

Types (recommended): doc, code, task, decision, pin
Status: draft (WIP), published (default), archived (soft-deleted)
Task status: pending, in_progress, done, blocked (for type=task)`,

  schema: {
    channel: z.string().describe("Channel the artifact belongs to"),
    name: z.string().describe("Unique name within the channel (e.g., 'auth-spec', 'task-login')"),
    type: z.string().describe("Artifact type: doc, code, task, decision, pin, or custom"),
    content: z.string().describe("Markdown content of the artifact"),
    status: ArtifactStatusSchema.describe("Lifecycle status: draft, published, archived"),
    taskStatus: TaskStatusSchema.describe("For tasks: pending, in_progress, done, blocked"),
    labels: z.array(z.string()).optional().describe("Freeform tags like 'urgent', 'needs-review'"),
    assignees: z.array(z.string()).optional().describe("Agent callsigns for task assignment"),
    parentId: z.string().optional().describe("Parent artifact ID for threading"),
    messageRef: z.string().optional().describe("Message ID this artifact references (for pins)"),
  },

  handler: async ({ channel, name, type, content, status, taskStatus, labels, assignees, parentId, messageRef }: {
    channel: string;
    name: string;
    type: string;
    content: string;
    status?: "draft" | "published" | "archived";
    taskStatus?: "pending" | "in_progress" | "done" | "blocked";
    labels?: string[];
    assignees?: string[];
    parentId?: string;
    messageRef?: string;
  }, store: any, sender: string) => {
    // Check if artifact exists (for upsert)
    const existing = store.getArtifact(channel, name);

    const artifact = store.createOrUpdateArtifact({
      channel,
      name,
      type: existing?.type || type, // Don't change type on update
      content,
      status: status || "published",
      taskStatus,
      labels,
      assignees,
      parentId,
      messageRef,
      createdBy: existing?.createdBy || sender,
      updatedBy: existing ? sender : undefined,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: existing ? "updated" : "created",
          artifact,
        }, null, 2),
      }],
    };
  },
};

/**
 * Tool: get_artifact
 * Retrieve a single artifact by name
 */
export const getArtifactTool = {
  name: "get_artifact",
  description: "Get an artifact by name. Use #channel/name syntax to read from other channels.",

  schema: {
    channel: z.string().describe("Channel name (or #other-channel for cross-channel)"),
    name: z.string().describe("Artifact name"),
  },

  handler: async ({ channel, name }: { channel: string; name: string }, store: any) => {
    // Handle cross-channel syntax: #other-channel
    const actualChannel = channel.startsWith("#") ? channel.slice(1) : channel;

    const artifact = store.getArtifact(actualChannel, name);

    if (!artifact) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Artifact not found: ${name} in #${actualChannel}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(artifact, null, 2),
      }],
    };
  },
};

/**
 * Tool: list_artifacts
 * List artifacts in a channel with optional filters
 */
export const listArtifactsTool = {
  name: "list_artifacts",
  description: "List artifacts in a channel. Filter by type, status, or assignee.",

  schema: {
    channel: z.string().describe("Channel name"),
    type: z.string().optional().describe("Filter by type (doc, code, task, etc.)"),
    status: ArtifactStatusSchema.describe("Filter by status"),
    assignee: z.string().optional().describe("Filter tasks by assignee"),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },

  handler: async ({ channel, type, status, assignee, limit }: {
    channel: string;
    type?: string;
    status?: "draft" | "published" | "archived";
    assignee?: string;
    limit?: number;
  }, store: any) => {
    const artifacts = store.listArtifacts(channel, {
      type,
      status,
      assignee,
      limit: limit || 50,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          channel,
          count: artifacts.length,
          artifacts: artifacts.map((a: any) => ({
            name: a.name,
            type: a.type,
            status: a.status,
            taskStatus: a.taskStatus,
            labels: a.labels,
            updatedAt: a.updatedAt || a.createdAt,
          })),
        }, null, 2),
      }],
    };
  },
};

/**
 * Tool: update_task_status
 * Convenience tool for updating task lifecycle
 */
export const updateTaskStatusTool = {
  name: "update_task_status",
  description: "Update the status of a task artifact. Use when claiming, completing, or blocking work.",

  schema: {
    channel: z.string().describe("Channel name"),
    name: z.string().describe("Task artifact name"),
    taskStatus: z.enum(["pending", "in_progress", "done", "blocked"]).describe("New task status"),
  },

  handler: async ({ channel, name, taskStatus }: {
    channel: string;
    name: string;
    taskStatus: "pending" | "in_progress" | "done" | "blocked";
  }, store: any, sender: string) => {
    const artifact = store.getArtifact(channel, name);

    if (!artifact) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Task not found: ${name}`,
        }],
      };
    }

    if (artifact.type !== "task") {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Artifact '${name}' is not a task (type: ${artifact.type})`,
        }],
      };
    }

    const updated = store.updateArtifact(channel, name, {
      taskStatus,
      updatedBy: sender,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "status_updated",
          name,
          previousStatus: artifact.taskStatus,
          newStatus: taskStatus,
          updatedBy: sender,
        }, null, 2),
      }],
    };
  },
};

/**
 * Tool: archive_artifact
 * Soft delete an artifact
 */
export const archiveArtifactTool = {
  name: "archive_artifact",
  description: "Archive an artifact (soft delete). The artifact is preserved but hidden from default listings.",

  schema: {
    channel: z.string().describe("Channel name"),
    name: z.string().describe("Artifact name to archive"),
  },

  handler: async ({ channel, name }: { channel: string; name: string }, store: any, sender: string) => {
    const success = store.archiveArtifact(channel, name, sender);

    if (!success) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Failed to archive: artifact '${name}' not found in #${channel}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "archived",
          channel,
          name,
          archivedBy: sender,
        }, null, 2),
      }],
    };
  },
};

/**
 * Integration code for src/server/index.ts
 *
 * Add these tool registrations inside createMcpServer() after existing tools:
 *
 * ```typescript
 * // Artifact tools
 * server.tool(
 *   "publish_artifact",
 *   publishArtifactTool.description,
 *   publishArtifactTool.schema,
 *   async (params) => publishArtifactTool.handler(params, store, "system")
 * );
 *
 * server.tool(
 *   "get_artifact",
 *   getArtifactTool.description,
 *   getArtifactTool.schema,
 *   async (params) => getArtifactTool.handler(params, store)
 * );
 *
 * server.tool(
 *   "list_artifacts",
 *   listArtifactsTool.description,
 *   listArtifactsTool.schema,
 *   async (params) => listArtifactsTool.handler(params, store)
 * );
 *
 * server.tool(
 *   "update_task_status",
 *   updateTaskStatusTool.description,
 *   updateTaskStatusTool.schema,
 *   async (params) => updateTaskStatusTool.handler(params, store, "system")
 * );
 *
 * server.tool(
 *   "archive_artifact",
 *   archiveArtifactTool.description,
 *   archiveArtifactTool.schema,
 *   async (params) => archiveArtifactTool.handler(params, store, "system")
 * );
 * ```
 *
 * Note: The "system" sender should be replaced with the actual agent callsign
 * once we figure out how to pass that through the MCP context.
 */
