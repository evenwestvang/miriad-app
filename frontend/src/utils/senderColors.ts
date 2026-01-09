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

// Raw hex colors matching the Tailwind palette above
const AGENT_HEX_COLORS = [
  '#60a5fa', // blue-400
  '#c084fc', // purple-400
  '#22d3ee', // cyan-400
  '#fb923c', // orange-400
  '#f472b6', // pink-400
  '#2dd4bf', // teal-400
  '#818cf8', // indigo-400
  '#fbbf24', // amber-400
]

/**
 * Get the raw hex color for a sender's status dot.
 * Used in AgentRoster for colored dots.
 *
 * @param sender - The callsign or sender name
 * @returns Hex color string (e.g., '#60a5fa')
 */
export function getSenderDotColor(sender: string): string {
  // Humans get green
  if (PREDEFINED_COLORS[sender]) {
    return '#22c55e' // green-500
  }

  // Generate deterministic color from sender name (same hash as getSenderColor)
  let hash = 0
  for (let i = 0; i < sender.length; i++) {
    hash = sender.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AGENT_HEX_COLORS[Math.abs(hash) % AGENT_HEX_COLORS.length]
}
