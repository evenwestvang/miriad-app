// Server
export { createServer, type ServerOptions, type CicadaServer } from "./server.js";

// Tymbal utilities - re-exported from @cikada/core
export {
  tymbal,
  tymbal as gasp, // Backwards compatibility
  parseFrame,
  generateMessageId,
  createMessageHandle,
} from "@cikada/core/tymbal";
export type {
  TymbalFrame,
  TymbalFrame as GaspFrame, // Backwards compatibility
  StartFrame,
  AppendFrame,
  SetFrame,
  ResetFrame as DeleteFrame,
  SyncRequest as SyncFrame,
  ErrorFrame,
  MessageHandle,
} from "@cikada/core/tymbal";

// Storage (for testing/debugging)
export { storage, MemoryStorage, type StoredMessage, type ThreadState } from "./storage.js";

// Driver (for advanced use cases)
export { createDriver, type DriverOptions, type RunOptions } from "./driver.js";

// Durable execution primitives
export {
  DurableSqliteStorage,
  createLocalDurableContext,
  createDurableDriver,
  resolveCallback,
  callbackEmitter,
  type DurableContext,
  type CreateDurableContextOptions,
  type DurableDriverOptions,
  type DurableRunOptions,
  type Execution,
  type Checkpoint,
  type MapProgress,
  type Callback,
} from "./durable/index.js";

// Testing utilities and LLM adapters
export {
  MockLLMAdapter,
  AnthropicLLMAdapter,
  createAnthropicAdapter,
  mockTextResponse,
  mockToolCall,
  mockTextWithToolCall,
  mockToolUseSequence,
  type LLMAdapter,
  type LLMStreamOptions,
  type StreamChunk,
  type MockResponse,
  type MockLLMOptions,
  type ToolDefinition,
  type AnthropicAdapterOptions,
} from "./testing/index.js";

// Sandbox (Docker orchestration for claude-code)
export {
  DockerOrchestrator,
  ContainerStateStore,
  type DockerOrchestratorOptions,
  type ContainerInfo,
  type ContainerState,
  type ContainerStatus,
  type SendMessageOptions,
} from "./sandbox/index.js";

// Artifact storage (board system)
export {
  ArtifactStorage,
  getArtifactStorage,
  resetArtifactStorage,
  type Artifact,
  type ArtifactType,
  type ArtifactStatus,
  type ArtifactFilters,
  type ArtifactSummary,
  type ArtifactTreeNode,
  type CASChange,
  type CASResult,
  type CreateArtifactInput,
  type ArtifactChangeAction,
  type ArtifactChangeCallback,
  type ArtifactStorageOptions,
} from "./artifact-storage.js";

// Reactive driver (native MCP integration)
export {
  MCPClient,
  ToolRegistry,
  createReactiveDriver,
  type MCPServerConfig,
  type MCPTool,
  type MCPToolResult,
  type RegisteredTool,
  type AgentToolDefinition,
  type ToolExecutionContext,
  type ReactiveDriverOptions,
  type ReactiveRunOptions,
} from "./reactive/index.js";
