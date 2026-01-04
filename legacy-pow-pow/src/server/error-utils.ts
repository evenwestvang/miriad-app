/**
 * Error Normalization Utilities
 *
 * Provides utilities for normalizing errors across different provider SDKs
 * into unified ProviderError instances with appropriate error codes and
 * retry hints.
 */

import { ProviderError, ProviderErrorCode } from "./agent-provider.js";

/**
 * Patterns for detecting rate limit errors across providers.
 */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /429/,
  /quota.?exceeded/i,
  /capacity/i,
  /overloaded/i,
];

/**
 * Patterns for detecting authentication errors.
 */
const AUTH_ERROR_PATTERNS = [
  /auth/i,
  /unauthorized/i,
  /401/,
  /403/,
  /forbidden/i,
  /api.?key/i,
  /invalid.?token/i,
  /permission.?denied/i,
];

/**
 * Patterns for detecting timeout errors.
 */
const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed.?out/i,
  /deadline.?exceeded/i,
  /ETIMEDOUT/,
  /ESOCKETTIMEDOUT/,
];

/**
 * Patterns for detecting network errors.
 */
const NETWORK_ERROR_PATTERNS = [
  /network/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /socket.?hang.?up/i,
  /connection.?refused/i,
  /fetch.?failed/i,
];

/**
 * Classify an error message/code into a ProviderErrorCode.
 */
export function classifyError(
  error: unknown,
  provider: string
): { code: ProviderErrorCode; retryable: boolean } {
  const message = getErrorMessage(error);
  const code = getErrorCode(error);

  // Check rate limit
  if (matchesAnyPattern(message, RATE_LIMIT_PATTERNS) ||
      matchesAnyPattern(code, RATE_LIMIT_PATTERNS)) {
    return { code: "rate_limit", retryable: true };
  }

  // Check auth errors
  if (matchesAnyPattern(message, AUTH_ERROR_PATTERNS) ||
      matchesAnyPattern(code, AUTH_ERROR_PATTERNS)) {
    return { code: "auth_error", retryable: false };
  }

  // Check timeout
  if (matchesAnyPattern(message, TIMEOUT_PATTERNS) ||
      matchesAnyPattern(code, TIMEOUT_PATTERNS)) {
    return { code: "timeout", retryable: true };
  }

  // Check network errors
  if (matchesAnyPattern(message, NETWORK_ERROR_PATTERNS) ||
      matchesAnyPattern(code, NETWORK_ERROR_PATTERNS)) {
    return { code: "network_error", retryable: true };
  }

  // Default to unknown
  return { code: "unknown", retryable: false };
}

/**
 * Normalize any error into a ProviderError.
 */
export function normalizeError(
  error: unknown,
  provider: string,
  context?: string
): ProviderError {
  const message = getErrorMessage(error);
  const { code, retryable } = classifyError(error, provider);

  const fullMessage = context ? `${context}: ${message}` : message;

  return new ProviderError(fullMessage, code, retryable, provider, error);
}

/**
 * Create a ProviderError for a specific error code.
 */
export function createProviderError(
  message: string,
  code: ProviderErrorCode,
  provider: string,
  cause?: unknown
): ProviderError {
  const retryable = isRetryableCode(code);
  return new ProviderError(message, code, retryable, provider, cause);
}

/**
 * Check if an error code is typically retryable.
 */
export function isRetryableCode(code: ProviderErrorCode): boolean {
  switch (code) {
    case "rate_limit":
    case "timeout":
    case "network_error":
      return true;
    case "auth_error":
    case "invalid_config":
    case "session_error":
    case "tool_error":
    case "unknown":
    default:
      return false;
  }
}

/**
 * Get retry delay for rate limit errors with exponential backoff.
 */
export function getRetryDelay(
  attempt: number,
  baseDelay = 1000,
  maxDelay = 30000
): number {
  const delay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.3 * delay; // Add 0-30% jitter
  return Math.min(delay + jitter, maxDelay);
}

/**
 * Extract retry-after hint from error if available.
 */
export function getRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  // Check for retryAfter property
  const err = error as Record<string, unknown>;
  if (typeof err.retryAfter === "number") {
    return err.retryAfter * 1000; // Convert to ms
  }

  // Check headers for Retry-After
  const headers = err.headers as Record<string, string> | undefined;
  if (headers?.["retry-after"]) {
    const retryAfter = parseInt(headers["retry-after"], 10);
    if (!isNaN(retryAfter)) {
      return retryAfter * 1000;
    }
  }

  return undefined;
}

/**
 * Retry a function with exponential backoff for retryable errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    provider: string;
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    onRetry?: (error: ProviderError, attempt: number, delay: number) => void;
  }
): Promise<T> {
  const {
    provider,
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    onRetry,
  } = options;

  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const providerError = err instanceof ProviderError
        ? err
        : normalizeError(err, provider);

      lastError = providerError;

      // Log raw error for debugging
      console.error(
        `[${provider}] Attempt ${attempt}/${maxAttempts} failed:`,
        {
          code: providerError.code,
          message: providerError.message,
          retryable: providerError.retryable,
          rawError: providerError.cause,
        }
      );

      // Don't retry if not retryable or last attempt
      if (!providerError.retryable || attempt === maxAttempts) {
        throw providerError;
      }

      // Calculate delay
      const retryAfter = getRetryAfter(err);
      const delay = retryAfter || getRetryDelay(attempt, baseDelay, maxDelay);

      // Notify callback
      onRetry?.(providerError, attempt, delay);

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError || new ProviderError("Unknown error", "unknown", false, provider);
}

// Helper functions

function getErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    return String((error as Record<string, unknown>).message);
  }
  return String(error);
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const err = error as Record<string, unknown>;
  if (typeof err.code === "string") return err.code;
  if (typeof err.status === "number") return String(err.status);
  if (typeof err.statusCode === "number") return String(err.statusCode);
  return "";
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
