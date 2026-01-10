import { Circle } from "lucide-react";
import { getRosterColor } from "../../utils/senderColors";

interface CartoucheProps {
  /** The name/callsign - for tooltip */
  name: string;
  /** Channel ID - used to shuffle color order */
  channelId?: string;
  /** Roster index - determines which color from the shuffled palette */
  rosterIndex?: number;
  /** Whether this is a human (user) - renders as emdash instead of colored circle */
  isHuman?: boolean;
  className?: string;
}

/**
 * Cartouche: A visual identifier for message senders.
 *
 * - Agents: colored circle, color determined by roster position
 * - Humans: emdash (—)
 */
export function Cartouche({
  name,
  channelId = "",
  rosterIndex = 0,
  isHuman = false,
  className = "",
}: CartoucheProps) {
  // Humans get an emdash
  if (isHuman) {
    return (
      <span className={`inline-flex items-center ${className}`} title={name}>
        <span className="text-black dark:text-white leading-none">—</span>
      </span>
    );
  }

  // Agents get colored circles (color determined by channel + roster position)
  const color = getRosterColor(channelId, rosterIndex);

  return (
    <span className={`inline-flex items-center ${className}`} title={name}>
      <Circle size="1em" color={color} fill={color} strokeWidth={0} />
    </span>
  );
}
