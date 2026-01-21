import { useState, useRef, useEffect } from 'react'
import { Menu, X, Settings, LogOut, Sun, Moon } from 'lucide-react'

interface MobileMenuProps {
  currentUser: string
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onLogout: () => void
}

export function MobileMenu({
  currentUser,
  theme,
  onToggleTheme,
  onOpenSettings,
  onLogout,
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Close menu on escape
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  return (
    <div ref={menuRef} className="relative">
      {/* Hamburger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-[var(--cast-bg-hover)] transition-colors"
        aria-label="Menu"
      >
        {isOpen ? (
          <X className="w-5 h-5 text-[var(--cast-text-muted)]" />
        ) : (
          <Menu className="w-5 h-5 text-[var(--cast-text-muted)]" />
        )}
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-card border border-border rounded-lg shadow-lg py-1 z-50">
          {/* User callsign */}
          <div className="px-4 py-2 border-b border-border">
            <span className="text-base font-medium text-foreground">@{currentUser}</span>
          </div>

          {/* Settings */}
          <button
            onClick={() => {
              onOpenSettings()
              setIsOpen(false)
            }}
            className="w-full flex items-center gap-3 px-4 py-3 text-base text-foreground hover:bg-[var(--cast-bg-hover)] transition-colors"
          >
            <Settings className="w-4 h-4 text-[var(--cast-text-muted)]" />
            Settings
          </button>

          {/* Dark mode toggle */}
          <button
            onClick={() => {
              onToggleTheme()
              setIsOpen(false)
            }}
            className="w-full flex items-center gap-3 px-4 py-3 text-base text-foreground hover:bg-[var(--cast-bg-hover)] transition-colors"
          >
            {theme === 'light' ? (
              <>
                <Moon className="w-4 h-4 text-[var(--cast-text-muted)]" />
                Dark Mode
              </>
            ) : (
              <>
                <Sun className="w-4 h-4 text-[var(--cast-text-muted)]" />
                Light Mode
              </>
            )}
          </button>

          {/* Logout */}
          <button
            onClick={() => {
              onLogout()
              setIsOpen(false)
            }}
            className="w-full flex items-center gap-3 px-4 py-3 text-base text-foreground hover:bg-[var(--cast-bg-hover)] transition-colors border-t border-border"
          >
            <LogOut className="w-4 h-4 text-[var(--cast-text-muted)]" />
            Log Out
          </button>
        </div>
      )}
    </div>
  )
}
