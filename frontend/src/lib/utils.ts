import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Common MIME types by extension for attachment rendering hints.
 * Used to determine how to preview attachments (image vs pdf vs generic).
 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
}

/**
 * Get MIME type from filename/slug extension.
 * Returns 'application/octet-stream' for unknown types.
 */
export function getMimeType(filename: string): string {
  const ext = filename.includes('.')
    ? '.' + filename.split('.').pop()!.toLowerCase()
    : ''
  return MIME_TYPES[ext] || 'application/octet-stream'
}
