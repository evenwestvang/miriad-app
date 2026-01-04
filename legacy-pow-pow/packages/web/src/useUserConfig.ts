import { useState, useEffect } from 'react'
import { UserConfig } from './types'

const COOKIE_NAME = 'powpow_user'
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 // 1 year in seconds

// Random adjective + animal name generator (matches wrapper)
const ADJECTIVES = [
  'swift', 'clever', 'brave', 'calm', 'eager', 'fierce', 'gentle', 'happy',
  'jolly', 'keen', 'lively', 'merry', 'noble', 'proud', 'quick', 'bold',
  'bright', 'chill', 'cool', 'daring', 'epic', 'fancy', 'grand', 'lucky',
]

const ANIMALS = [
  'fox', 'owl', 'bear', 'wolf', 'hawk', 'lynx', 'deer', 'hare',
  'crow', 'duck', 'frog', 'lion', 'moth', 'seal', 'swan', 'wren',
]

function generateCallsign(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return adj + '-' + animal
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'))
  return match ? decodeURIComponent(match[2]) : null
}

function setCookie(name: string, value: string, maxAge: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`
}

export function useUserConfig(): {
  config: UserConfig | null
  setName: (name: string) => void
  isLoading: boolean
} {
  const [config, setConfig] = useState<UserConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const stored = getCookie(COOKIE_NAME)
    if (stored) {
      try {
        setConfig(JSON.parse(stored))
      } catch {
        // Generate new if invalid
        const newConfig: UserConfig = {
          name: generateCallsign(),
          createdAt: new Date().toISOString(),
        }
        setCookie(COOKIE_NAME, JSON.stringify(newConfig), COOKIE_MAX_AGE)
        setConfig(newConfig)
      }
    }
    setIsLoading(false)
  }, [])

  const setName = (name: string) => {
    const newConfig: UserConfig = {
      name,
      createdAt: config?.createdAt || new Date().toISOString(),
    }
    setCookie(COOKIE_NAME, JSON.stringify(newConfig), COOKIE_MAX_AGE)
    setConfig(newConfig)
  }

  return { config, setName, isLoading }
}
