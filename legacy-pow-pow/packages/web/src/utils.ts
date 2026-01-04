import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime(timestamp: string): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatRelativeTime(timestamp: string | number): string {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  
  if (minutes < 1) return 'now'
  if (minutes < 60) return minutes + 'm'
  if (hours < 24) return hours + 'h'
  return days + 'd'
}

export function getStatusColor(connectedAt: number): string {
  const now = Date.now()
  const diff = now - connectedAt
  const minutes = diff / 60000
  
  if (minutes < 5) return 'bg-green-500' // online
  if (minutes < 15) return 'bg-yellow-500' // idle
  return 'bg-gray-500' // offline
}

// Parse @mentions from content
export function parseMentions(content: string): { text: string; isMention: boolean; mentionType?: 'user' | 'channel' }[] {
  const parts: { text: string; isMention: boolean; mentionType?: 'user' | 'channel' }[] = []
  const regex = /@(channel|[\w-]+)/gi
  let lastIndex = 0
  let match

  while ((match = regex.exec(content)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push({ text: content.slice(lastIndex, match.index), isMention: false })
    }
    // Add the mention
    const mentionType = match[1].toLowerCase() === 'channel' ? 'channel' : 'user'
    parts.push({ text: match[0], isMention: true, mentionType })
    lastIndex = regex.lastIndex
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push({ text: content.slice(lastIndex), isMention: false })
  }

  return parts.length ? parts : [{ text: content, isMention: false }]
}

// Get unique senders from messages (for autocomplete)
export function getUniqueSenders(messages: { sender: string }[]): string[] {
  const senders = new Set<string>()
  messages.forEach(m => senders.add(m.sender))
  return Array.from(senders).sort()
}
