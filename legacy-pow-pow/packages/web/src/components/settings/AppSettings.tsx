import { ArrowLeft, Settings } from 'lucide-react'

interface AppSettingsProps {
  onClose: () => void
}

export function AppSettings({ onClose }: AppSettingsProps) {
  return (
    <div className="flex-1 flex min-h-0">
      {/* Settings sidebar */}
      <div className="w-48 border-r bg-card flex flex-col shrink-0">
        <div className="p-3 border-b">
          <button
            onClick={onClose}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
        <div className="p-2 flex-1">
          <div className="text-xs text-muted-foreground uppercase px-2 py-1 font-medium">Settings</div>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Settings className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-sm">System configuration is now managed in #root</p>
          <p className="text-xs mt-2">Visit the #root channel to manage agents and playbooks</p>
        </div>
      </div>
    </div>
  )
}
