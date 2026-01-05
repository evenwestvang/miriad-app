import { X, Check, User } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { SummonRequestField as SummonRequestFieldType } from '../../types'

interface SummonAgent {
  callsign: string
  definitionSlug: string
  purpose: string
}

interface SummonRequestFieldProps {
  field: SummonRequestFieldType
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
}

export function SummonRequestField({ field, value, onChange, disabled }: SummonRequestFieldProps) {
  const selectedCallsigns = value

  const handleReject = (callsign: string) => {
    onChange(selectedCallsigns.filter((c) => c !== callsign))
  }

  const handleRestore = (callsign: string) => {
    onChange([...selectedCallsigns, callsign])
  }

  return (
    <div className="space-y-2">
      <div className="mb-2">
        <label className="text-sm font-medium text-foreground">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </label>
        {field.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
        )}
      </div>
      <div className="space-y-2">
        {field.agents.map((agent) => {
          const isSelected = selectedCallsigns.includes(agent.callsign)
          return (
            <AgentCard
              key={agent.callsign}
              agent={agent}
              isSelected={isSelected}
              onReject={() => handleReject(agent.callsign)}
              onRestore={() => handleRestore(agent.callsign)}
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
  onReject: () => void
  onRestore: () => void
  disabled?: boolean
}

function AgentCard({ agent, isSelected, onReject, onRestore, disabled }: AgentCardProps) {
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
          <span className="font-medium text-sm">@{agent.callsign}</span>
          <span className="text-xs text-muted-foreground">({agent.definitionSlug})</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {agent.purpose}
        </p>
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

interface SummonRequestSubmittedProps {
  field: SummonRequestFieldType
  approvedCallsigns: string[]
}

export function SummonRequestSubmitted({ field, approvedCallsigns }: SummonRequestSubmittedProps) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">{field.label}</label>
      <div className="space-y-1.5">
        {field.agents.map((agent) => {
          const isApproved = approvedCallsigns.includes(agent.callsign)
          return (
            <div
              key={agent.callsign}
              className={cn(
                'flex items-center gap-2 text-sm',
                isApproved ? 'text-foreground' : 'text-muted-foreground line-through'
              )}
            >
              {isApproved ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <X className="w-4 h-4 text-destructive" />
              )}
              <span>@{agent.callsign}</span>
              <span className="text-xs text-muted-foreground">- {agent.purpose}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
