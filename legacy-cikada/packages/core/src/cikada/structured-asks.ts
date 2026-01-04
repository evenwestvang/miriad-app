/**
 * Structured Asks Types
 *
 * Types for form-based messages that agents can post for humans to respond to.
 */

// =============================================================================
// Field Types
// =============================================================================

interface BaseField {
  /** Unique field identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional help text */
  description?: string;
  /** Whether field is required */
  required?: boolean;
}

export interface RadioField extends BaseField {
  type: 'radio';
  options: { value: string; label: string }[];
}

export interface CheckboxField extends BaseField {
  type: 'checkbox';
  options: { value: string; label: string }[];
}

export interface SelectField extends BaseField {
  type: 'select';
  options: { value: string; label: string }[];
}

export interface TextField extends BaseField {
  type: 'text';
  placeholder?: string;
}

export interface TextareaField extends BaseField {
  type: 'textarea';
  placeholder?: string;
}

export interface SummonRequestField extends BaseField {
  type: 'summon_request';
  agents: {
    callsign: string;
    definitionSlug: string;
    purpose: string;
  }[];
}

export type StructuredAskField =
  | RadioField
  | CheckboxField
  | SelectField
  | TextField
  | TextareaField
  | SummonRequestField;

// =============================================================================
// Form Data Types
// =============================================================================

export interface StructuredAskFormData {
  /** The prompt text shown above the form */
  prompt: string;
  /** Form fields */
  fields: StructuredAskField[];
  /** Custom submit button text (default: "Submit") */
  submitLabel?: string;
  /** Target recipients (callsigns) - empty array means anyone can respond */
  to: string[];
}

export type StructuredAskFormState = 'pending' | 'submitted';

// =============================================================================
// Message Types
// =============================================================================

/**
 * A structured ask message as stored in the database.
 */
export interface StructuredAskMessage {
  /** Unique message identifier (ULID) */
  id: string;
  /** Message type discriminator */
  type: 'structured_ask';
  /** Channel this message belongs to */
  channelId: string;
  /** Who sent this message (agent callsign) */
  sender: string;
  /** ISO timestamp */
  timestamp: string;
  /** The prompt text (duplicated from formData for convenience) */
  content: string;
  /** Form definition */
  formData: StructuredAskFormData;
  /** Form state */
  formState: StructuredAskFormState;
  /** Field responses keyed by field id (only present after submission) */
  response?: Record<string, unknown>;
  /** Who submitted the response */
  respondedBy?: string;
  /** When the response was submitted */
  respondedAt?: string;
}

// =============================================================================
// API Types
// =============================================================================

export interface CreateStructuredAskRequest {
  /** Who is creating this structured ask */
  sender: string;
  /** The prompt text */
  prompt: string;
  /** Form fields */
  fields: StructuredAskField[];
  /** Custom submit button text */
  submitLabel?: string;
  /** Target recipients (callsigns) */
  to?: string[];
}

export interface SubmitStructuredAskRequest {
  /** Field responses keyed by field id */
  response: Record<string, unknown>;
  /** Who is submitting */
  respondedBy: string;
}

export interface SubmitStructuredAskResponse {
  /** The updated message (StoredMessage with structured ask content) */
  message: unknown;
  /** Whether the submission was successful */
  success: boolean;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isStructuredAskMessage(value: unknown): value is StructuredAskMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as StructuredAskMessage).type === 'structured_ask' &&
    typeof (value as StructuredAskMessage).id === 'string' &&
    typeof (value as StructuredAskMessage).channelId === 'string' &&
    typeof (value as StructuredAskMessage).formData === 'object'
  );
}

export function isStructuredAskField(value: unknown): value is StructuredAskField {
  if (typeof value !== 'object' || value === null) return false;
  const field = value as StructuredAskField;
  return (
    typeof field.id === 'string' &&
    typeof field.label === 'string' &&
    ['radio', 'checkbox', 'select', 'text', 'textarea', 'summon_request'].includes(field.type)
  );
}
