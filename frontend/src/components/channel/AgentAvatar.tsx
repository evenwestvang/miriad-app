import { useState } from 'react'
import { getAgentAvatar, getHumanAvatar } from '../../lib/avatars'

interface AgentAvatarProps {
  /** Channel ID for deterministic avatar selection */
  channelId: string
  /** Agent's index in the roster (0-based) */
  agentIndex: number
  /** Display name for alt text and fallback initial */
  displayName: string
  /** Size class (default: w-10 h-10) */
  size?: 'sm' | 'md' | 'lg'
  /** Additional className */
  className?: string
}

const sizeClasses = {
  sm: 'w-6 h-6 text-xs',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-base',
}

/**
 * Agent avatar with image and fallback to initial letter.
 * Uses deterministic avatar assignment based on channel and roster position.
 */
export function AgentAvatar({
  channelId,
  agentIndex,
  displayName,
  size = 'md',
  className = '',
}: AgentAvatarProps) {
  const [imageError, setImageError] = useState(false)
  const avatarUrl = getAgentAvatar(channelId, agentIndex)
  const initial = displayName.charAt(0).toUpperCase()
  const sizeClass = sizeClasses[size]

  return (
    <div className={`relative flex-shrink-0 ${sizeClass} ${className}`}>
      {/* Fallback - always rendered behind */}
      <div
        className={`${sizeClass} rounded-full bg-[var(--cast-bg-active)] flex items-center justify-center font-medium text-[var(--cast-text-secondary)]`}
      >
        {initial}
      </div>
      {/* Image - overlays fallback when loaded */}
      {!imageError && (
        <img
          src={avatarUrl}
          alt={displayName}
          className={`${sizeClass} rounded-full object-cover absolute inset-0`}
          onError={() => setImageError(true)}
        />
      )}
    </div>
  )
}

interface UserAvatarProps {
  /** User ID for deterministic avatar selection */
  userId: string
  /** Display name for alt text and fallback initial */
  displayName: string
  /** Size class (default: w-10 h-10) */
  size?: 'sm' | 'md' | 'lg'
  /** Additional className */
  className?: string
}

/**
 * User avatar with watercolor blot image and fallback to initial letter.
 * Uses deterministic avatar assignment based on user ID hash.
 */
export function UserAvatar({
  userId,
  displayName,
  size = 'md',
  className = '',
}: UserAvatarProps) {
  const [imageError, setImageError] = useState(false)
  const avatarUrl = getHumanAvatar(userId)
  const initial = displayName.charAt(0).toUpperCase()
  const sizeClass = sizeClasses[size]

  return (
    <div className={`relative flex-shrink-0 ${sizeClass} ${className}`}>
      {/* Fallback - always rendered behind */}
      <div
        className={`${sizeClass} rounded-full bg-[var(--cast-bg-active)] flex items-center justify-center font-medium text-[var(--cast-text-secondary)]`}
      >
        {initial}
      </div>
      {/* Image - overlays fallback when loaded */}
      {!imageError && (
        <img
          src={avatarUrl}
          alt={displayName}
          className={`${sizeClass} rounded-full object-cover absolute inset-0`}
          onError={() => setImageError(true)}
        />
      )}
    </div>
  )
}
