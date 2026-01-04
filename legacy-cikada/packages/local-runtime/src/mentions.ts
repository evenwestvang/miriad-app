/**
 * @mention Parser and Routing Utilities
 *
 * Parses @mentions from message content and determines routing targets.
 */

// =============================================================================
// Types
// =============================================================================

export interface ParsedMentions {
  /** List of mentioned callsigns (without @) */
  mentions: string[];
  /** Whether @channel was mentioned (broadcast to all) */
  isChannelMention: boolean;
  /** Original message content */
  content: string;
}

export interface RoutingResult {
  /** Agent callsigns to route the message to */
  targets: string[];
  /** Whether this is a broadcast to all agents */
  isBroadcast: boolean;
}

// =============================================================================
// Mention Parser
// =============================================================================

/**
 * Parse @mentions from message content.
 *
 * Supports:
 * - @callsign - mention specific agent
 * - @channel - broadcast to all agents
 *
 * Examples:
 * - "@fox help me" -> { mentions: ["fox"], isChannelMention: false }
 * - "@fox @bear coordinate" -> { mentions: ["fox", "bear"], isChannelMention: false }
 * - "@channel status update" -> { mentions: [], isChannelMention: true }
 * - "hello" -> { mentions: [], isChannelMention: false }
 */
export function parseMentions(content: string): ParsedMentions {
  // Match @word patterns (alphanumeric and hyphens/underscores)
  const mentionPattern = /@([a-zA-Z0-9_-]+)/g;
  const matches = content.matchAll(mentionPattern);

  const mentions: string[] = [];
  let isChannelMention = false;

  for (const match of matches) {
    const mention = match[1].toLowerCase();
    if (mention === "channel") {
      isChannelMention = true;
    } else {
      // Avoid duplicates
      if (!mentions.includes(mention)) {
        mentions.push(mention);
      }
    }
  }

  return {
    mentions,
    isChannelMention,
    content,
  };
}

// =============================================================================
// Routing Logic
// =============================================================================

export interface ChannelRoster {
  /** All agent callsigns in the channel */
  agents: string[];
  /** The channel leader (receives unaddressed human messages) */
  leader: string;
}

/**
 * Determine routing targets based on mentions and sender.
 *
 * Rules:
 * - @callsign -> route to that agent
 * - @channel -> broadcast to all agents
 * - No mentions from human -> route to channel leader
 * - No mentions from agent -> no routing (just logged)
 */
export function determineRouting(
  parsed: ParsedMentions,
  senderIsHuman: boolean,
  roster: ChannelRoster
): RoutingResult {
  // @channel broadcasts to all agents
  if (parsed.isChannelMention) {
    return {
      targets: [...roster.agents],
      isBroadcast: true,
    };
  }

  // Specific @mentions
  if (parsed.mentions.length > 0) {
    // Filter to only agents that exist in the roster
    const validTargets = parsed.mentions.filter((m) =>
      roster.agents.includes(m)
    );
    return {
      targets: validTargets,
      isBroadcast: false,
    };
  }

  // No mentions
  if (senderIsHuman) {
    // Human messages without mentions go to the leader
    return {
      targets: [roster.leader],
      isBroadcast: false,
    };
  }

  // Agent messages without mentions are just logged (no routing)
  return {
    targets: [],
    isBroadcast: false,
  };
}

/**
 * Extract the message content with mentions stripped (optional utility).
 * Useful if you want to show clean content without @mentions.
 */
export function stripMentions(content: string): string {
  return content.replace(/@[a-zA-Z0-9_-]+/g, "").replace(/\s+/g, " ").trim();
}
