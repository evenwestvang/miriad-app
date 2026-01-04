import { ChannelMetadata } from '@/types'
import { EditableField } from '@/components/ui/editable-field'

interface ChannelSettingsProps {
  channel: string
  metadata: ChannelMetadata
  onUpdate: (metadata: Partial<ChannelMetadata>) => void
}

export function ChannelSettings({
  channel,
  metadata,
  onUpdate,
}: ChannelSettingsProps) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Channel Settings</h3>
          <p className="text-sm text-muted-foreground">
            Configure the metadata for #{channel}
          </p>
        </div>

        <EditableField
          label="Tagline"
          value={metadata.tagline || ''}
          onChange={(value) => onUpdate({ tagline: value })}
          placeholder="Click to add a tagline"
        />

        <EditableField
          label="Mission"
          value={metadata.mission || ''}
          onChange={(value) => onUpdate({ mission: value })}
          placeholder="Click to add a mission statement"
          multiline
          minHeight="min-h-[6rem]"
        />
      </div>
    </div>
  )
}
