/**
 * Sender color utilities for consistent callsign coloring across the UI.
 * Used in message attribution, agent roster, @mention autocomplete, Cartouche, etc.
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
 * 24 colors that work well in both light and dark modes.
 * Used for Cartouche and roster dots.
 */
const ROSTER_COLORS = [
  "#FF6600", // orange (brand)
  "#E5194D", // red
  "#FF9ED0", // pink
  "#9B4DCA", // purple
  "#3359FF", // blue
  "#00B8D9", // cyan
  "#00A86B", // green
  "#B8D500", // lime
  "#FFB700", // gold
  "#8B5E3C", // brown
]

/**
 * FNV-1a hash function for strings.
 * Returns a 32-bit integer.
 */
function hashString(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Shuffle an array using a seed (Fisher-Yates with seeded random).
 */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array]
  let s = seed

  // Simple seeded random number generator (mulberry32)
  const random = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}

/**
 * Get a hex color for an agent based on channel and roster position.
 * Colors are shuffled per-channel so each channel has a unique color order.
 *
 * @param channelId - The channel ID (used to shuffle color order)
 * @param rosterIndex - The agent's index in the roster
 * @returns Hex color string (e.g., '#FF6600')
 */
export function getRosterColor(channelId: string, rosterIndex: number): string {
  const channelSeed = hashString(channelId)
  const shuffledColors = seededShuffle(ROSTER_COLORS, channelSeed)
  return shuffledColors[rosterIndex % shuffledColors.length]
}

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
