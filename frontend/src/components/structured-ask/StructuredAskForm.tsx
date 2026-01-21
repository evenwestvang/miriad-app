import { useState } from 'react'
import { Send } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StructuredAskMessage, StructuredAskField } from '../../types'
import {
  RadioField,
  CheckboxField,
  SelectField,
  TextField,
  TextareaField,
} from './fields'
import { SummonRequestField, SummonRequestSubmitted } from './SummonRequestField'

interface StructuredAskFormProps {
  message: StructuredAskMessage
  myName: string
  onSubmit: (messageId: string, response: Record<string, unknown>) => void
}

type FormValues = Record<string, string | string[]>

export function StructuredAskForm({ message, myName, onSubmit }: StructuredAskFormProps) {
  const { formData, formState, response, respondedBy } = message

  const { prompt, fields, submitLabel, to } = formData
  const isSubmitted = formState === 'submitted'
  const canSubmit = to.length === 0 || to.includes(myName)

  // Initialize form values
  const [values, setValues] = useState<FormValues>(() => {
    const initial: FormValues = {}
    for (const field of fields) {
      if (field.type === 'summon_request') {
        // Opt-out: ALL agents enabled by default
        initial[field.id] = field.agents?.map((a) => a.callsign) || []
      } else if (field.type === 'checkbox') {
        initial[field.id] = []
      } else {
        initial[field.id] = ''
      }
    }
    return initial
  })

  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleFieldChange = (fieldId: string, value: string | string[]) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmitting || isSubmitted) return

    setIsSubmitting(true)
    try {
      await onSubmit(message.id, values)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Determine visual state
  const isTargeted = canSubmit && !isSubmitted

  return (
    <div
      className={cn(
        'border p-4 max-w-md',
        isSubmitted && 'bg-muted/50 border-muted',
        isTargeted && 'border-yellow-500/50 ring-1 ring-yellow-500/20',
        !isSubmitted && !isTargeted && 'bg-[#f5f5f5] dark:bg-[var(--cast-bg-active)] border-[var(--cast-border-default)]'
      )}
    >
      {/* Prompt */}
      <p className="text-base font-medium mb-4">{prompt}</p>

      {/* Targeted indicator */}
      {to.length > 0 && !isSubmitted && (
        <div className="text-xs text-muted-foreground mb-3">
          {canSubmit ? (
            <span className="text-yellow-500">Waiting for your response</span>
          ) : (
            <span>Waiting for: {to.map((t) => `@${t}`).join(', ')}</span>
          )}
        </div>
      )}

      {isSubmitted ? (
        <SubmittedView fields={fields} response={response || {}} respondedBy={respondedBy} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map((field) => (
            <FieldRenderer
              key={field.id}
              field={field}
              value={values[field.id]}
              onChange={(value) => handleFieldChange(field.id, value)}
              disabled={!canSubmit || isSubmitting}
            />
          ))}

          {canSubmit && (
            <button
              type="submit"
              disabled={isSubmitting}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-base font-medium',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-colors'
              )}
            >
              <Send className="w-4 h-4" />
              {isSubmitting ? 'Submitting...' : (submitLabel || 'Submit')}
            </button>
          )}
        </form>
      )}
    </div>
  )
}

interface FieldRendererProps {
  field: StructuredAskField
  value: string | string[]
  onChange: (value: string | string[]) => void
  disabled: boolean
}

function FieldRenderer({ field, value, onChange, disabled }: FieldRendererProps) {
  switch (field.type) {
    case 'radio':
      return (
        <RadioField
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'checkbox':
      return (
        <CheckboxField
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'select':
      return (
        <SelectField
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'text':
      return (
        <TextField
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'textarea':
      return (
        <TextareaField
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'summon_request':
      return (
        <SummonRequestField
          field={field}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
        />
      )
    default:
      return null
  }
}

interface SubmittedViewProps {
  fields: StructuredAskField[]
  response: Record<string, unknown>
  respondedBy?: string
}

function SubmittedView({ fields, response, respondedBy }: SubmittedViewProps) {
  return (
    <div className="space-y-3">
      {respondedBy && (
        <p className="text-xs text-muted-foreground">
          Submitted by @{respondedBy}
        </p>
      )}
      {fields.map((field) => {
        const value = response[field.id]
        return (
          <SubmittedFieldValue key={field.id} field={field} value={value} />
        )
      })}
    </div>
  )
}

interface SubmittedFieldValueProps {
  field: StructuredAskField
  value: unknown
}

function SubmittedFieldValue({ field, value }: SubmittedFieldValueProps) {
  if (field.type === 'summon_request') {
    const approvedCallsigns = Array.isArray(value) ? value as string[] : []
    return <SummonRequestSubmitted field={field} approvedCallsigns={approvedCallsigns} />
  }

  // Format display value
  let displayValue: string
  if (Array.isArray(value)) {
    // For checkbox, find labels
    if (field.type === 'checkbox') {
      const labels = value.map((v) => {
        const opt = field.options.find((o) => o.value === v)
        return opt?.label || v
      })
      displayValue = labels.join(', ')
    } else {
      displayValue = value.join(', ')
    }
  } else if (typeof value === 'string') {
    // For radio/select, find label
    if ((field.type === 'radio' || field.type === 'select') && 'options' in field) {
      const opt = field.options.find((o) => o.value === value)
      displayValue = opt?.label || value
    } else {
      displayValue = value
    }
  } else {
    displayValue = String(value ?? '')
  }

  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
      <p className="text-base">{displayValue || <span className="text-muted-foreground italic">No response</span>}</p>
    </div>
  )
}
