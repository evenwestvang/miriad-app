import { useState } from 'react'
import { StructuredAskMessage, StructuredAskField, SummonRequestAgent } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatTime } from '@/utils'

interface StructuredAskFormProps {
  message: StructuredAskMessage
  myName: string
  onSubmit: (messageId: string, values: Record<string, string | string[]>) => void
}

function RadioField({ field, value, onChange }: {
  field: StructuredAskField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-2">
      {field.options?.map((option) => (
        <label key={option.value} className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name={field.id}
            value={option.value}
            checked={value === option.value}
            onChange={(e) => onChange(e.target.value)}
            className="w-4 h-4 text-primary"
          />
          <span className="text-sm">{option.label}</span>
        </label>
      ))}
    </div>
  )
}

function CheckboxField({ field, value, onChange }: {
  field: StructuredAskField
  value: string[]
  onChange: (value: string[]) => void
}) {
  const handleChange = (optionValue: string, checked: boolean) => {
    if (checked) {
      onChange([...value, optionValue])
    } else {
      onChange(value.filter(v => v !== optionValue))
    }
  }

  return (
    <div className="space-y-2">
      {field.options?.map((option) => (
        <label key={option.value} className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            value={option.value}
            checked={value.includes(option.value)}
            onChange={(e) => handleChange(option.value, e.target.checked)}
            className="w-4 h-4 text-primary"
          />
          <span className="text-sm">{option.label}</span>
        </label>
      ))}
    </div>
  )
}

function SelectField({ field, value, onChange }: {
  field: StructuredAskField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
    >
      <option value="">Select an option...</option>
      {field.options?.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function TextField({ field, value, onChange }: {
  field: StructuredAskField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      className="w-full"
    />
  )
}

function TextareaField({ field, value, onChange }: {
  field: StructuredAskField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      rows={3}
      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm resize-none"
    />
  )
}

function SummonRequestField({ field, value, onChange }: {
  field: StructuredAskField
  value: string[]  // contains callsigns of ENABLED agents (not rejected)
  onChange: (value: string[]) => void
}) {
  const agents = field.agents || []
  const isEnabled = (callsign: string) => value.includes(callsign)

  const toggleAgent = (callsign: string) => {
    if (isEnabled(callsign)) {
      // Remove from enabled list (reject)
      onChange(value.filter(v => v !== callsign))
    } else {
      // Add back to enabled list (re-approve)
      onChange([...value, callsign])
    }
  }

  if (agents.length === 0) {
    return <div className="text-sm text-muted-foreground">No agents proposed</div>
  }

  return (
    <div className="space-y-2">
      {agents.map((agent) => {
        const enabled = isEnabled(agent.callsign)
        return (
          <div
            key={agent.callsign}
            className={cn(
              "flex items-start gap-2 p-2 rounded border",
              enabled ? "border-border hover:bg-muted/50" : "border-muted opacity-60"
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-sm font-medium",
                  !enabled && "line-through text-muted-foreground"
                )}>
                  @{agent.callsign}
                </span>
                <span className={cn(
                  "text-xs px-1.5 py-0.5 rounded bg-muted",
                  !enabled && "opacity-50"
                )}>
                  {agent.definitionSlug}
                </span>
              </div>
              <p className={cn(
                "text-xs text-muted-foreground mt-1",
                !enabled && "line-through"
              )}>
                {agent.purpose}
              </p>
            </div>
            <button
              type="button"
              onClick={() => toggleAgent(agent.callsign)}
              className={cn(
                "w-6 h-6 flex items-center justify-center rounded text-sm font-medium transition-colors shrink-0",
                enabled
                  ? "text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
                  : "text-muted-foreground hover:text-green-500 hover:bg-green-500/10"
              )}
              title={enabled ? "Reject agent" : "Re-approve agent"}
            >
              {enabled ? "×" : "+"}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function SummonRequestSubmitted({ field, approvedCallsigns }: {
  field: StructuredAskField
  approvedCallsigns: string[]
}) {
  const agents = field.agents || []

  if (agents.length === 0) {
    return <div className="text-sm text-muted-foreground">No agents proposed</div>
  }

  const isApproved = (callsign: string) => approvedCallsigns.includes(callsign)

  return (
    <div className="space-y-2">
      {agents.map((agent) => {
        const approved = isApproved(agent.callsign)
        return (
          <div
            key={agent.callsign}
            className={cn(
              "flex items-start gap-2 p-2 rounded border",
              approved ? "border-green-500/30 bg-green-500/5" : "border-muted bg-muted/30"
            )}
          >
            <div className={cn(
              "w-5 h-5 flex items-center justify-center rounded-full text-xs shrink-0 mt-0.5",
              approved ? "bg-green-500/20 text-green-600" : "bg-muted text-muted-foreground"
            )}>
              {approved ? "✓" : "×"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-sm font-medium",
                  !approved && "line-through text-muted-foreground"
                )}>
                  @{agent.callsign}
                </span>
                <span className={cn(
                  "text-xs px-1.5 py-0.5 rounded bg-muted",
                  !approved && "opacity-50"
                )}>
                  {agent.definitionSlug}
                </span>
              </div>
              <p className={cn(
                "text-xs text-muted-foreground mt-1",
                !approved && "line-through"
              )}>
                {agent.purpose}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function StructuredAskForm({ message, myName, onSubmit }: StructuredAskFormProps) {
  const { formData, formState } = message

  // Extract data with defaults (before hooks to avoid conditional hook calls)
  const fields = formData?.fields || []
  const to = formData?.to || []
  const prompt = formData?.prompt || ''
  const submitLabel = formData?.submitLabel || 'Submit'

  const [values, setValues] = useState<Record<string, string | string[]>>(() => {
    // Initialize with empty values (except summon_request which defaults to all enabled)
    const initial: Record<string, string | string[]> = {}
    for (const field of fields) {
      if (field.type === 'summon_request') {
        // Opt-out model: all agents enabled by default (use callsigns)
        initial[field.id] = field.agents?.map(a => a.callsign) || []
      } else if (field.type === 'checkbox') {
        initial[field.id] = []
      } else {
        initial[field.id] = ''
      }
    }
    return initial
  })
  const [submitting, setSubmitting] = useState(false)

  // Defensive check for invalid form data (after hooks)
  if (!formData || fields.length === 0) {
    return <div className="text-sm text-muted-foreground">Invalid form data</div>
  }

  const isSubmitted = formState === 'submitted'
  const canSubmit = to.length === 0 || to.includes(myName)

  const handleSubmit = async () => {
    // Validate required fields
    for (const field of fields) {
      if (field.required) {
        const val = values[field.id]
        if (field.type === 'checkbox') {
          if ((val as string[]).length === 0) {
            return // Required checkbox not checked
          }
        } else {
          if (!val || (typeof val === 'string' && !val.trim())) {
            return // Required field empty
          }
        }
      }
    }

    setSubmitting(true)
    try {
      await onSubmit(message.id, values)
    } finally {
      setSubmitting(false)
    }
  }

  const setValue = (fieldId: string, value: string | string[]) => {
    setValues(prev => ({ ...prev, [fieldId]: value }))
  }

  // Get display value for submitted forms
  const getDisplayValue = (field: StructuredAskField): string => {
    const val = message.response?.[field.id]
    if (!val) return '-'

    if (field.type === 'summon_request' && Array.isArray(val)) {
      // Display approved agent callsigns
      return val.map(callsign => `@${callsign}`).join(', ') || '-'
    }

    if (field.type === 'checkbox' && Array.isArray(val)) {
      return val.map(v => {
        const opt = field.options?.find(o => o.value === v)
        return opt?.label || v
      }).join(', ') || '-'
    }

    if (field.type === 'radio' || field.type === 'select') {
      const opt = field.options?.find(o => o.value === val)
      return opt?.label || (val as string)
    }

    return val as string
  }

  const isForMe = to.length > 0 && to.includes(myName)

  return (
    <div className={cn(
      "border rounded-lg p-4 my-2 max-w-lg",
      isSubmitted ? "bg-muted/50 border-muted" :
        isForMe ? "bg-card border-yellow-500/50 ring-1 ring-yellow-500/20" : "bg-card border-border"
    )}>
      {/* Prompt with inline mentions */}
      <div className="font-medium mb-4">
        {to.length > 0 && (
          <>
            {to.map((t, i) => (
              <span key={t}>
                <span className={cn(
                  t === myName ? "text-yellow-500" : "text-muted-foreground"
                )}>
                  @{t}
                </span>
                {i < to.length - 1 && ', '}
              </span>
            ))}
            {': '}
          </>
        )}
        {prompt}
      </div>

      {/* Fields */}
      <div className="space-y-4">
        {fields.map((field) => (
          <div key={field.id}>
            <label className="block text-sm font-medium mb-1">
              {field.label}
              {field.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            {field.description && (
              <p className="text-xs text-muted-foreground mb-2">{field.description}</p>
            )}

            {isSubmitted ? (
              // Show submitted value
              field.type === 'summon_request' ? (
                <SummonRequestSubmitted
                  field={field}
                  approvedCallsigns={(message.response?.[field.id] as string[]) || []}
                />
              ) : (
                <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded">
                  {getDisplayValue(field)}
                </div>
              )
            ) : (
              // Show editable field
              <>
                {field.type === 'radio' && (
                  <RadioField
                    field={field}
                    value={values[field.id] as string}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
                {field.type === 'checkbox' && (
                  <CheckboxField
                    field={field}
                    value={values[field.id] as string[]}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
                {field.type === 'select' && (
                  <SelectField
                    field={field}
                    value={values[field.id] as string}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
                {field.type === 'text' && (
                  <TextField
                    field={field}
                    value={values[field.id] as string}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
                {field.type === 'textarea' && (
                  <TextareaField
                    field={field}
                    value={values[field.id] as string}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
                {field.type === 'summon_request' && (
                  <SummonRequestField
                    field={field}
                    value={values[field.id] as string[]}
                    onChange={(v) => setValue(field.id, v)}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Submit button or submitted info */}
      {isSubmitted ? (
        <div className="mt-4 text-xs text-muted-foreground">
          Submitted by {message.respondedBy} at {formatTime(message.respondedAt || '') || 'just now'}
        </div>
      ) : canSubmit ? (
        <Button
          onClick={handleSubmit}
          disabled={submitting}
          className="mt-4"
        >
          {submitting ? 'Submitting...' : submitLabel}
        </Button>
      ) : (
        <div className="mt-4 text-xs text-muted-foreground">
          Waiting for {to.map(t => `@${t}`).join(' or ')} to respond
        </div>
      )}
    </div>
  )
}
