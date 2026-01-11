import { Hash, MessageSquare, LayoutGrid } from 'lucide-react'
import { cn } from '../lib/utils'

export type MobileTab = 'channels' | 'thread' | 'board'

interface MobileNavProps {
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
  hasChannel: boolean // Whether a channel is selected
}

export function MobileNav({ activeTab, onTabChange, hasChannel }: MobileNavProps) {
  const tabs: { id: MobileTab; label: string; icon: typeof Hash }[] = [
    { id: 'channels', label: 'Channels', icon: Hash },
    { id: 'thread', label: 'Thread', icon: MessageSquare },
    { id: 'board', label: 'Board', icon: LayoutGrid },
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-14 bg-card border-t border-border flex md:hidden z-50">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id
        // Disable thread and board tabs if no channel selected
        const isDisabled = !hasChannel && (tab.id === 'thread' || tab.id === 'board')

        return (
          <button
            key={tab.id}
            onClick={() => !isDisabled && onTabChange(tab.id)}
            disabled={isDisabled}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
              'min-h-[44px]', // Touch target
              isActive
                ? 'text-primary'
                : isDisabled
                  ? 'text-muted-foreground/40 cursor-not-allowed'
                  : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="w-5 h-5" />
            <span className="text-xs font-medium">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
