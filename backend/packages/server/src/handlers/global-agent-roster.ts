/**
 * Global Agent Auto-Roster Helper
 *
 * Shared logic for resolving @mentions of global agents and auto-adding
 * them to the channel roster. Used by both the HTTP message endpoint
 * (messages.ts) and the MCP send_message handler (mcp-http.ts).
 */

import { generateMessageId } from '@cast/core';
import type { Storage } from '@cast/storage';
import type { ConnectionManager } from '../websocket/index.js';

export interface AutoRosterResult {
  /** Callsigns that were auto-rostered */
  resolved: string[];
}

/**
 * Resolve unresolved @mentions against global agents and auto-roster them.
 *
 * For each unresolved mention that matches a global agent configured on the space:
 * 1. Adds the agent to the channel roster (idempotent via ON CONFLICT)
 * 2. Broadcasts a roster join event so the UI updates in real-time
 *
 * Returns the list of callsigns that were resolved.
 */
export async function resolveAndRosterGlobalAgents(
  storage: Storage,
  spaceId: string,
  channelId: string,
  unresolvedMentions: string[],
  connectionManager?: ConnectionManager,
): Promise<AutoRosterResult> {
  if (unresolvedMentions.length === 0) {
    return { resolved: [] };
  }

  const globalAgents = await storage.getGlobalAgents(spaceId);
  const resolved: string[] = [];

  for (const mention of unresolvedMentions) {
    if (!globalAgents[mention]) continue;

    // addToRoster uses ON CONFLICT DO UPDATE — safe for concurrent calls
    const entry = await storage.addToRoster({
      channelId,
      callsign: mention,
      agentType: 'chorus',
      status: 'active',
    });

    resolved.push(mention);
    console.log(`[GlobalAgents] Auto-rostered @${mention} in channel ${channelId}`);

    // Broadcast roster join so the UI updates in real-time
    // (mirrors the pattern in app.ts summon flow)
    if (connectionManager) {
      const rosterFrame = {
        i: generateMessageId(),
        t: new Date().toISOString(),
        v: {
          type: 'roster',
          action: 'agent_joined',
          agent: {
            callsign: entry.callsign,
            agentType: entry.agentType,
            status: entry.status,
            runtimeId: entry.runtimeId,
            runtimeName: entry.runtimeName,
            runtimeStatus: entry.runtimeStatus,
          },
        },
        c: channelId,
      };
      await connectionManager.broadcast(channelId, JSON.stringify(rosterFrame));
    }
  }

  return { resolved };
}
