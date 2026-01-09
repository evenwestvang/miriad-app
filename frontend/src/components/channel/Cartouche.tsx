import { Circle, Square } from "lucide-react";

/**
 * FNV-1a hash function for strings.
 * Returns a 32-bit integer.
 */
function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 24 colors that work well in both light and dark modes.
 * Selected for visibility and distinctiveness across themes.
 */
const COLORS = [
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
];

/**
 * Shuffle an array using a seed (Fisher-Yates with seeded random).
 */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array];
  let s = seed;

  // Simple seeded random number generator (mulberry32)
  const random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

interface CartoucheProps {
  /** The name/callsign - for tooltip */
  name: string;
  /** Channel ID - used to shuffle color order */
  channelId?: string;
  /** Roster index - determines which color from the shuffled palette */
  rosterIndex?: number;
  /** Whether this is a human (user) - renders as black square instead of colored circle */
  isHuman?: boolean;
  className?: string;
}

/**
 * Cartouche: A visual identifier for message senders.
 *
 * - Agents: colored circle, color determined by roster position
 * - Humans: black square
 */
export function Cartouche({
  name,
  channelId = "",
  rosterIndex = 0,
  isHuman = false,
  className = "",
}: CartoucheProps) {
  // Humans get a black square
  if (isHuman) {
    return (
      <span className={`inline-flex items-center ${className}`} title={name}>
        <Square
          size="1em"
          className="text-black dark:text-white"
          fill="currentColor"
          strokeWidth={0}
        />
      </span>
    );
  }

  // Agents get colored circles
  // Shuffle colors based on channel ID so each channel has a different color order
  const channelSeed = hashString(channelId);
  const shuffledColors = seededShuffle(COLORS, channelSeed);

  // Pick color by roster index (wraps if more agents than colors)
  const color = shuffledColors[rosterIndex % shuffledColors.length];

  return (
    <span className={`inline-flex items-center ${className}`} title={name}>
      <Circle size="1em" color={color} fill={color} strokeWidth={0} />
    </span>
  );
}
