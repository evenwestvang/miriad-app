/**
 * Protocol types for local agent WebSocket communication.
 * Aligned with existing Tymbal protocol from agents/sandbox/src/tymbal-bridge.ts
 */

// ============================================================================
// Server -> Client Messages (Downstream)
// ============================================================================

export interface ConnectedMessage {
  type: "connected";
  version: string;
}

export interface RegisteredMessage {
  type: "registered";
  callsign: string;
  channelId: string;
}

export interface IncomingMessage {
  type: "message";
  id: string;
  channelId: string;
  callsign: string;
  content: string;
  sender: string;
  systemPrompt: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | ConnectedMessage
  | RegisteredMessage
  | IncomingMessage
  | ErrorMessage;

// ============================================================================
// Client -> Server Messages (Upstream)
// ============================================================================

export interface RegisterMessage {
  type: "register";
  channelId: string;
  callsign: string;
  workspace: string;
  token?: string; // Agent token (required in prod, optional localhost)
}

export interface FrameMessage {
  type: "frame";
  channelId: string;
  token?: string; // Agent token (required in prod, optional localhost)
  frame: TymbalFrame;
}

export type ClientMessage = RegisterMessage | FrameMessage;

// ============================================================================
// Tymbal Frames (aligned with agents/sandbox/src/tymbal-bridge.ts)
// ============================================================================

export interface TymbalFrame {
  i: string;                    // Message ID (ULID)
  t?: string;                   // Timestamp (ISO, for set frames)
  m?: TymbalMetadata;           // Metadata (for start frames)
  a?: string;                   // Append content (for append frames)
  v?: TymbalValue;              // Set value (for set frames)
}

export interface TymbalMetadata {
  type: TymbalValueType;
  sender: string;
  senderType: "agent";
}

export type TymbalValueType =
  | "agent"
  | "tool_call"
  | "tool_result"
  | "error"
  | "idle"
  | "cost";

// Base for all set frame values
interface TymbalValueBase {
  type: TymbalValueType;
  sender: string;
  senderType: "agent";
}

export interface AgentValue extends TymbalValueBase {
  type: "agent";
  content: string;
}

export interface ToolCallValue extends TymbalValueBase {
  type: "tool_call";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultValue extends TymbalValueBase {
  type: "tool_result";
  toolCallId: string;
  content: unknown;
  isError: boolean;
}

export interface ErrorValue extends TymbalValueBase {
  type: "error";
  content: string;
}

export interface IdleValue extends TymbalValueBase {
  type: "idle";
}

export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CostModelUsage extends CostUsage {
  costUsd: number;
}

export interface CostValue extends TymbalValueBase {
  type: "cost";
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: CostUsage;
  modelUsage?: Record<string, CostModelUsage>;
}

export type TymbalValue =
  | AgentValue
  | ToolCallValue
  | ToolResultValue
  | ErrorValue
  | IdleValue
  | CostValue;

// ============================================================================
// Configuration
// ============================================================================

export interface LocalAgentConfig {
  /** Channel ID to register in */
  channelId: string;
  /** Agent callsign */
  callsign: string;
  /** Local workspace directory */
  workspace: string;
  /** WebSocket host (e.g., localhost:3234 or ws.staging.caststack.ai) */
  wsHost: string;
  /** Use secure WebSocket (wss://) */
  secure?: boolean;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  ALREADY_REGISTERED: "ALREADY_REGISTERED",
  CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
  INVALID_MESSAGE: "INVALID_MESSAGE",
} as const;

// ============================================================================
// IPC Protocol (Stage 2 - Multi-Agent Server)
// ============================================================================

/** IPC Commands from CLI to Server */
export interface IPCAddCommand {
  type: "add";
  channelId: string;
  callsign: string;
  workspace: string;
}

export interface IPCRemoveCommand {
  type: "remove";
  channelId: string;
  callsign: string;
}

export interface IPCListCommand {
  type: "list";
}

export interface IPCStatusCommand {
  type: "status";
}

export type IPCCommand = IPCAddCommand | IPCRemoveCommand | IPCListCommand | IPCStatusCommand;

/** IPC Responses from Server to CLI */
export interface IPCOkResponse {
  type: "ok";
  message?: string;
}

export interface IPCErrorResponse {
  type: "error";
  message: string;
}

export interface IPCAgentInfo {
  channelId: string;
  callsign: string;
  workspace: string;
  status: "idle" | "processing" | "disconnected";
  registeredAt: string;
}

export interface IPCAgentsResponse {
  type: "agents";
  agents: IPCAgentInfo[];
}

export interface IPCStatusResponse {
  type: "status";
  connected: boolean;
  wsHost: string;
  agentCount: number;
  uptime: number;
}

export type IPCResponse = IPCOkResponse | IPCErrorResponse | IPCAgentsResponse | IPCStatusResponse;

// ============================================================================
// Agent Instance (Stage 2)
// ============================================================================

export interface AgentInstanceConfig {
  channelId: string;
  callsign: string;
  workspace: string;
}

export type AgentStatus = "idle" | "processing" | "disconnected";

// ============================================================================
// Stage 3: Server Credentials & Auth
// ============================================================================

/** Server credentials stored in ~/.config/cast/credentials.json */
export interface ServerCredentials {
  serverId: string;
  secret: string;
  spaceId: string;
  host: string;
  wsHost: string;
  createdAt: string;
}

/** Bootstrap exchange request */
export interface BootstrapRequest {
  bootstrapToken: string;
}

/** Bootstrap exchange response */
export interface BootstrapResponse {
  serverId: string;
  secret: string;
  spaceId: string;
  host: string;
  wsHost: string;
}

/** Agent token request */
export interface AgentTokenRequest {
  channelId: string;
  callsign: string;
}

/** Agent token response */
export interface AgentTokenResponse {
  token: string;
}

/** Parsed connection string */
export interface ParsedConnectionString {
  host: string;
  bootstrapToken: string;
  spaceId: string;
}
