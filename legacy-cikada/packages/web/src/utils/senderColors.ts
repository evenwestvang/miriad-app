/**
 * Sender color utilities for consistent callsign coloring across the UI.
 * Used in message attribution, agent roster, @mention autocomplete, etc.
 */

// Predefined colors for common senders
const PREDEFINED_COLORS: Record<string, string> = {
  human: 'text-green-500',
  user: 'text-green-500',
  You: 'text-green-500',
}

// Color palette for agent callsigns (good contrast on dark backgrounds)
const AGENT_COLORS = [
  'text-blue-400',
  'text-purple-400',
  'text-cyan-400',
  'text-orange-400',
  'text-pink-400',
  'text-teal-400',
  'text-indigo-400',
  'text-amber-400',
]

/**
 * Generate a consistent color class for a sender callsign.
 * Uses deterministic hashing so the same callsign always gets the same color.
 *
 * @param sender - The callsign or sender name
 * @returns Tailwind color class (e.g., 'text-blue-400')
 */
export function getSenderColor(sender: string): string {
  // Check predefined colors first
  if (PREDEFINED_COLORS[sender]) {
    return PREDEFINED_COLORS[sender]
  }

  // Generate deterministic color from sender name (djb2-style hash)
  let hash = 0
  for (let i = 0; i < sender.length; i++) {
    hash = sender.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}

/**
 * Get the background color variant for a sender (for badges, chips, etc.)
 *
 * @param sender - The callsign or sender name
 * @returns Tailwind background color class
 */
export function getSenderBgColor(sender: string): string {
  const textColor = getSenderColor(sender)
  // Convert text-X-400 to bg-X-400/20 for subtle background
  return textColor.replace('text-', 'bg-') + '/20'
}
