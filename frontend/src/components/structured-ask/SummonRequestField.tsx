import { useState, useEffect } from 'react'
import { X, Check, User, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { apiFetch } from '../../lib/api'
import type { SummonRequestField as SummonRequestFieldType, SummonRequestResponse } from '../../types'

interface SummonAgent {
  callsign: string
  definitionSlug: string
  purpose: string
}

interface RuntimeOption {
  id: string
  name: string
  status: 'online' | 'offline'
}

interface SummonRequestFieldProps {
  field: SummonRequestFieldType
  value: SummonRequestResponse[]
  onChange: (value: SummonRequestResponse[]) => void
  disabled?: boolean
  spaceId?: string
  apiHost?: string
  roster?: { callsign: string; runtimeId?: string | null }[]
}

export function SummonRequestField({ 
  field, 
  value, 
  onChange, 
  disabled,
  spaceId,
  apiHost = '',
  roster = []
}: SummonRequestFieldProps) {
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [isLoadingRuntimes, setIsLoadingRuntimes] = useState(false)
  const [defaultRuntimeId, setDefaultRuntimeId] = useState<string | null>(null)

  // Fetch runtimes on mount
  useEffect(() => {
    if (!spaceId) return

    const fetchRuntimes = async () => {
      setIsLoadingRuntimes(true)
      try {
        const response = await apiFetch(`${apiHost}/api/spaces/${spaceId}/runtimes`)
        if (!response.ok) {
          console.warn('Failed to load runtimes')
          return
        }
        const data = await response.json()
        const onlineRuntimes = (data.runtimes || []).filter(
          (r: RuntimeOption) => r.status === 'online'
        )
        setRuntimes(onlineRuntimes)

        // Determine default runtime (same logic as AgentSummonPicker)
        const availableIds = onlineRuntimes.map((r: RuntimeOption) => r.id)
        const miriadCloud = onlineRuntimes.find((r: RuntimeOption) => r.name === 'Miriad Cloud')
        const rosterRuntimeId = roster.find(a => a.runtimeId && availableIds.includes(a.runtimeId))?.runtimeId

        let defaultId: string | null = null
        if (rosterRuntimeId) {
          defaultId = rosterRuntimeId
        } else if (miriadCloud) {
          defaultId = miriadCloud.id
        } else if (onlineRuntimes.length > 0) {
          defaultId = onlineRuntimes[0].id
        }
        setDefaultRuntimeId(defaultId)

        // Update existing values with default runtime if they don't have one
        if (defaultId && value.length > 0) {
          const updatedValue = value.map(v => ({
            ...v,
            runtimeId: v.runtimeId ?? defaultId
          }))
          // Only update if something changed
          if (updatedValue.some((v, i) => v.runtimeId !== value[i]?.runtimeId)) {
            onChange(updatedValue)
          }
        }
      } catch (err) {
        console.warn('Failed to load runtimes:', err)
      } finally {
        setIsLoadingRuntimes(false)
      }
    }

    fetchRuntimes()
  }, [spaceId, apiHost])

  const handleReject = (callsign: string) => {
    onChange(value.filter((v) => v.callsign !== callsign))
  }

  const handleRestore = (callsign: string) => {
    onChange([...value, { callsign, runtimeId: defaultRuntimeId }])
  }

  const handleRuntimeChange = (callsign: string, runtimeId: string | null) => {
    onChange(value.map(v => 
      v.callsign === callsign ? { ...v, runtimeId } : v
    ))
  }

  const selectedCallsigns = value.map(v => v.callsign)

  return (
    <div className="space-y-2">
      <div className="mb-2">
        <label className="text-base font-medium text-foreground">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </label>
      </div>
      <div className="space-y-2">
        {field.agents.map((agent) => {
          const isSelected = selectedCallsigns.includes(agent.callsign)
          const agentValue = value.find(v => v.callsign === agent.callsign)
          return (
            <AgentCard
              key={agent.callsign}
              agent={agent}
              isSelected={isSelected}
              selectedRuntimeId={agentValue?.runtimeId ?? null}
              runtimes={runtimes}
              isLoadingRuntimes={isLoadingRuntimes}
              onReject={() => handleReject(agent.callsign)}
              onRestore={() => handleRestore(agent.callsign)}
              onRuntimeChange={(runtimeId) => handleRuntimeChange(agent.callsign, runtimeId)}
              disabled={disabled}
            />
          )
        })}
      </div>
    </div>
  )
}

interface AgentCardProps {
  agent: SummonAgent
  isSelected: boolean
  selectedRuntimeId: string | null
  runtimes: RuntimeOption[]
  isLoadingRuntimes: boolean
  onReject: () => void
  onRestore: () => void
  onRuntimeChange: (runtimeId: string | null) => void
  disabled?: boolean
}

function AgentCard({ 
  agent, 
  isSelected, 
  selectedRuntimeId,
  runtimes,
  isLoadingRuntimes,
  onReject, 
  onRestore, 
  onRuntimeChange,
  disabled 
}: AgentCardProps) {
  const [showRuntimeDropdown, setShowRuntimeDropdown] = useState(false)
  const selectedRuntime = runtimes.find(r => r.id === selectedRuntimeId)

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-3 rounded-md border transition-colors',
        isSelected
          ? 'bg-card border-border'
          : 'bg-muted/50 border-muted opacity-60'
      )}
    >
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
        <User className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-base">@{agent.callsign}</span>
          <span className="text-xs text-muted-foreground">({agent.definitionSlug})</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {agent.purpose}
        </p>
        {/* Runtime selector - compact by default */}
        {isSelected && runtimes.length > 0 && !disabled && (
          <div className="mt-2 relative">
            <button
              type="button"
              onClick={() => setShowRuntimeDropdown(!showRuntimeDropdown)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>on {selectedRuntime?.name || 'Select runtime'}</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            {showRuntimeDropdown && (
              <div className="absolute top-full left-0 mt-1 z-10 bg-popover border border-border rounded-md shadow-md py-1 min-w-[160px]">
                {runtimes.map(runtime => (
                  <button
                    key={runtime.id}
                    type="button"
                    onClick={() => {
                      onRuntimeChange(runtime.id)
                      setShowRuntimeDropdown(false)
                    }}
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors',
                      runtime.id === selectedRuntimeId && 'bg-accent/50'
                    )}
                  >
                    {runtime.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isSelected && isLoadingRuntimes && (
          <div className="mt-2 text-xs text-muted-foreground">Loading runtimes...</div>
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={isSelected ? onReject : onRestore}
          className={cn(
            'flex-shrink-0 p-1.5 rounded-md transition-colors',
            isSelected
              ? 'hover:bg-destructive/10 text-muted-foreground hover:text-destructive'
              : 'hover:bg-primary/10 text-muted-foreground hover:text-primary'
          )}
          title={isSelected ? 'Reject agent' : 'Restore agent'}
        >
          {isSelected ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}
        </button>
      )}
    </div>
  )
}
