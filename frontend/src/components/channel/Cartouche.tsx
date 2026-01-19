interface CartoucheProps {
  /** The name/callsign - for tooltip */
  name: string;
  /** Channel ID - unused, kept for API compatibility */
  channelId?: string;
  /** Roster index - unused, kept for API compatibility */
  rosterIndex?: number;
  /** Whether this is a human (user) - unused, all senders now render the same */
  isHuman?: boolean;
  className?: string;
}

/**
 * Cartouche: A visual identifier for message senders.
 *
 * All senders (humans and agents) render as an emdash (—).
 */
export function Cartouche({
  name,
  className = "",
}: CartoucheProps) {
  return (
    <span className={`inline-flex items-center ${className}`} title={name}>
      <span className="text-black dark:text-white leading-none">—</span>
    </span>
  );
}
