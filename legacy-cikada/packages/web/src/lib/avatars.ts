/**
 * Deterministic avatar assignment for agents and humans.
 *
 * Agents: Each channel gets a unique shuffle of available avatars based on its ID.
 * Agents are assigned avatars by their roster index, ensuring no duplicates
 * within the same channel (up to AGENT_AVATAR_COUNT agents).
 *
 * Humans: Each user gets a deterministic avatar based on a hash of their user ID.
 */

const AGENT_AVATAR_COUNT = 31
const HUMAN_AVATAR_COUNT = 63

/**
 * djb2 hash function for strings.
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  return hash >>> 0
}

/**
 * Fisher-Yates shuffle with a seeded PRNG for deterministic results.
 */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array]
  let m = result.length
  let s = seed
  while (m) {
    const i = s % m--
    s = (s * 1103515245 + 12345) >>> 0
    ;[result[m], result[i]] = [result[i], result[m]]
  }
  return result
}

/**
 * Get the avatar URL for an agent based on channel and roster position.
 *
 * @param channelId - The channel ID (used to seed the shuffle)
 * @param agentIndex - The agent's position in the roster (0-based)
 * @returns Path to the avatar image (e.g., "/avatars/avatar-001.jpeg")
 */
export function getAgentAvatar(channelId: string, agentIndex: number): string {
  const seed = hashString(channelId)
  const indices = Array.from({ length: AGENT_AVATAR_COUNT }, (_, i) => i + 1)
  const shuffled = seededShuffle(indices, seed)
  const avatarNum = shuffled[agentIndex % AGENT_AVATAR_COUNT]
  return `/avatars/avatar-${String(avatarNum).padStart(3, '0')}.jpeg`
}

/**
 * Get the avatar URL for a human user based on their user ID.
 *
 * @param userId - The user's unique ID (used to determine avatar)
 * @returns Path to the avatar image (e.g., "/human-avatars/human-001.png")
 */
export function getHumanAvatar(userId: string): string {
  const hash = hashString(userId)
  const avatarNum = (hash % HUMAN_AVATAR_COUNT) + 1
  return `/human-avatars/human-${String(avatarNum).padStart(3, '0')}.png`
}
