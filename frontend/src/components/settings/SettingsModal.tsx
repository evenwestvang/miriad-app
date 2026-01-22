import { useState, useEffect } from 'react'
import { X, Settings, Monitor, Cloud, Plug } from 'lucide-react'
import { RuntimesSettings } from './RuntimesSettings'
import { CloudSettings } from './CloudSettings'
import { IntegrationsSettings } from './IntegrationsSettings'

export type SettingsSection = 'cloud' | 'runtimes' | 'integrations'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  apiHost: string
  spaceId?: string
  initialSection?: SettingsSection
}

export function SettingsModal({ isOpen, onClose, apiHost, spaceId, initialSection = 'cloud' }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)

  // Update active section when initialSection changes (e.g., opening from different places)
  useEffect(() => {
    if (isOpen) {
      setActiveSection(initialSection)
    }
  }, [isOpen, initialSection])

  if (!isOpen) return null

  const sections: { id: SettingsSection; label: string; icon: typeof Monitor }[] = [
    { id: 'cloud', label: 'Miriad Cloud', icon: Cloud },
    { id: 'runtimes', label: 'Local Runtimes', icon: Monitor },
    { id: 'integrations', label: 'Integrations', icon: Plug },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-3xl max-h-[80vh] bg-card border border-border rounded-lg shadow-lg flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 border-r border-border bg-secondary/20 p-2 flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 mb-2">
            <Settings className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-base">Settings</span>
          </div>
          <nav className="space-y-1">
            {sections.map(section => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-base rounded-md transition-colors ${
                  activeSection === section.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary/50'
                }`}
              >
                <section.icon className="w-4 h-4" />
                {section.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
            <h2 className="text-lg font-semibold">
              {sections.find(s => s.id === activeSection)?.label}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-secondary rounded-md transition-colors"
            >
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeSection === 'cloud' && spaceId && (
              <CloudSettings apiHost={apiHost} spaceId={spaceId} />
            )}
            {activeSection === 'runtimes' && spaceId && (
              <RuntimesSettings apiHost={apiHost} spaceId={spaceId} />
            )}
            {activeSection === 'integrations' && spaceId && (
              <IntegrationsSettings apiHost={apiHost} spaceId={spaceId} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
