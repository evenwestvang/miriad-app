/**
 * @cikada/aws-runtime
 *
 * AWS Lambda runtime for the Cicada agent framework.
 *
 * This package provides:
 * - Lambda handlers for WebSocket (connect, disconnect, sync)
 * - Lambda handlers for HTTP API (start-thread, send-message)
 * - Agent durable execution handler
 * - DynamoDB utilities
 * - Tymbal protocol helpers
 *
 * Usage in deployment:
 *
 * ```ts
 * // lambdas/agent/index.ts
 * import { registerAgents, createDurableAgentHandler } from "@cikada/aws-runtime";
 * import { myAgent, weatherAgent } from "./agents.js";
 *
 * registerAgents({
 *   myAgent,
 *   weatherAgent,
 * });
 *
 * export const handler = await createDurableAgentHandler();
 * ```
 */

// Tymbal utilities - re-exported from @cikada/core
export { tymbal } from "@cikada/core/tymbal";
// Backwards compatibility alias
export { tymbal as gasp } from "@cikada/core/tymbal";
export { generateMessageId, generateUlid } from "./shared/ulid.js";
export { broadcast, hasListeners, sendToConnection } from "./shared/broadcast.js";
export {
  registerConnection,
  removeConnection,
  getConnections,
  findConnectionByConnectionId,
  persistMessage,
  getThreadHistory,
  getThreadMeta,
  createThread,
  updateThreadMeta,
  addChildThread,
  threadExists,
  type ThreadMeta,
  type StoredMessage,
  type Connection,
} from "./shared/db.js";

// Lambda handlers
export { handler as connectHandler } from "./lambdas/connect/handler.js";
export { handler as disconnectHandler } from "./lambdas/disconnect/handler.js";
export { handler as syncHandler } from "./lambdas/sync/handler.js";
export { handler as sendMessageHandler } from "./lambdas/send-message/handler.js";
export { handler as startThreadHandler } from "./lambdas/start-thread/handler.js";
export { handler as listAgentsHandler } from "./lambdas/list-agents/handler.js";
export { handler as listThreadsHandler } from "./lambdas/list-threads/handler.js";
export { handler as getMessagesHandler } from "./lambdas/get-messages/handler.js";

// Process handler (agents and workflows)
export {
  registerProcesses,
  createProcessHandler,
  createDurableProcessHandler,
} from "./lambdas/agent/handler.js";

// SDK Agent handler (Claude Agent SDK integration)
// NOTE: SDK requires CLI subprocess - use raw agent for Lambda
export {
  runSDKAgent,
  createSDKAgentHandler,
  type SDKAgentEvent,
} from "./lambdas/sdk-agent/handler.js";

// Raw Agent handler (direct Anthropic API - Lambda native)
export {
  runRawAgent,
  createRawAgentHandler,
  type RawAgentEvent,
} from "./lambdas/raw-agent/handler.js";
