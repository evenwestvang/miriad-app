import {
  Square,
  Circle,
  Triangle,
  Diamond,
  Hexagon,
  Octagon,
  Pentagon,
  Star,
  Heart,
  Zap,
  Flame,
  Sparkles,
  Sun,
  Moon,
  Cloud,
  Snowflake,
  type LucideIcon,
} from "lucide-react";

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
 * Curated Lucide icons for visual identification.
 * Selected for distinctiveness and visual appeal.
 */
const ICONS: LucideIcon[] = [
  Square,
  Circle,
  Triangle,
  Diamond,
  Hexagon,
  Octagon,
  Pentagon,
  Star,
  Heart,
  Zap,
  Flame,
  Sparkles,
  Sun,
  Moon,
  Cloud,
  Snowflake,
];

/**
 * Bold, distinct colors for agent types.
 * These are hand-picked for good visibility and distinction.
 */
const AGENT_COLORS = [
  "#e63946", // red
  "#f77f00", // orange
  "#fcbf49", // yellow/gold
  "#2a9d8f", // teal
  "#219ebc", // blue
  "#8338ec", // purple
  "#ff006e", // magenta/pink
  "#06d6a0", // green
  "#118ab2", // deep blue
  "#ef476f", // coral
];

interface CartoucheProps {
  /** The name/callsign - determines the icon */
  name: string;
  /** The agent type - determines color. Falls back to name if not provided. */
  agentType?: string;
  className?: string;
}

/**
 * Cartouche: A Lucide icon that serves as a visual identifier.
 *
 * - Single icon, inline with text
 * - Icon selection determined by name (stable per user)
 * - Color determined by agent type
 */
export function Cartouche({ name, agentType, className = "" }: CartoucheProps) {
  // Pick color based on agent type
  const colorSource = agentType || name;
  const colorSeed = hashString(colorSource);
  const color = AGENT_COLORS[colorSeed % AGENT_COLORS.length];

  // Use name for icon selection
  const iconSeed = hashString(name);
  const iconIndex = iconSeed % ICONS.length;
  const Icon = ICONS[iconIndex];

  return (
    <span className={`inline-flex items-center ${className}`} title={name}>
      <Icon size="1em" color={color} fill={color} strokeWidth={0} />
    </span>
  );
}
