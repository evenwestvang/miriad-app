/**
 * Tymbal Protocol
 *
 * NDJSON streaming protocol for real-time message delivery.
 */

// Frame types and type guards
export {
  // Frame types
  type StartFrame,
  type AppendFrame,
  type SetFrame,
  type ResetFrame,
  type SyncRequest,
  type SyncResponse,
  type ErrorFrame,
  type ArtifactFrame,
  type ArtifactPayload,
  type MessageFrame,
  type ControlFrame,
  type TymbalFrame,
  type MessageMetadata,
  type MessageType,
  // SetFrame value types
  type SetFrameValueBase,
  type TextMessageValue,
  type ToolCallValue,
  type ToolResultValue,
  type ThinkingValue,
  type StatusValue,
  type ErrorValue,
  type IdleValue,
  type SetFrameValue,
  // Type guards
  isStartFrame,
  isAppendFrame,
  isSetFrame,
  isResetFrame,
  isSyncRequest,
  isSyncResponse,
  isErrorFrame,
  isArtifactFrame,
  isMessageFrame,
  isControlFrame,
} from './frames.js';

// Parser and serializer
export {
  parseFrame,
  parseFrames,
  serializeFrame,
  serializeFrameLine,
} from './parser.js';

// Builders and utilities
export {
  tymbal,
  createMessageHandle,
  generateMessageId,
  type MessageHandle,
  type MessageHandleOptions,
} from './builders.js';
