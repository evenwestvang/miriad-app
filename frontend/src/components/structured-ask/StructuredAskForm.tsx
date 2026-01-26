import { useState } from 'react'
import { cn } from '../../lib/utils'
import type { StructuredAskMessage, StructuredAskField, SummonRequestResponse } from '../../types'
import {
  RadioField,
  CheckboxField,
  SelectField,
  TextField,
  TextareaField,
  SecretField,
} from './fields'
import { SummonRequestField } from './SummonRequestField'

interface StructuredAskFormProps {
  message: StructuredAskMessage
  onSubmit: (messageId: string, response: Record<string, unknown>) => void
  /** Called when user cancels/dismisses the form */
  onCancel?: (messageId: string) => void
  spaceId?: string
  apiHost?: string
  roster?: { callsign: string; runtimeId?: string | null }[]
  /** When true, shows sender callsign and close button in header (for popup mode) */
  popupMode?: boolean
  /** Called when close button is clicked (only in popup mode) */
  onClose?: () => void
}

type FormValues = Record<string, string | string[] | SummonRequestResponse[]>

export function StructuredAskForm({ message, onSubmit, onCancel, spaceId, apiHost, roster, popupMode, onClose }: StructuredAskFormProps) {
  const { formData, formState, response, respondedBy } = message

  const { prompt, fields, submitLabel, cancelLabel } = formData
  const isSubmitted = formState === 'submitted'
  const isDismissed = formState === 'dismissed'
  // For now, any user can submit (single-user system)
  const canSubmit = true

  // Initialize form values
  const [values, setValues] = useState<FormValues>(() => {
    const initial: FormValues = {}
    for (const field of fields) {
      if (field.type === 'summon_request') {
        // Opt-out: ALL agents enabled by default (runtimeId will be set when runtimes load)
        initial[field.name] = field.agents.map(agent => ({
          callsign: agent.callsign,
          runtimeId: null
        }))
      } else if (field.type === 'checkbox') {
        initial[field.name] = field.default || []
      } else {
        // radio, select, text, textarea
        initial[field.name] = field.default || ''
      }
    }
    return initial
  })

  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleFieldChange = (fieldName: string, value: string | string[] | SummonRequestResponse[]) => {
    setValues((prev) => ({ ...prev, [fieldName]: value }))
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
  const isTargeted = canSubmit && !isSubmitted && !isDismissed

  return (
    <div
      className={cn(
        'max-w-md border p-4 bg-white dark:bg-card',
        (isSubmitted || isDismissed) && 'bg-muted/50 border-muted',
        isTargeted && 'border-yellow-500/50 ring-1 ring-yellow-500/20',
        !isSubmitted && !isDismissed && !isTargeted && 'bg-[#f5f5f5] dark:bg-[var(--cast-bg-active)] border-[var(--cast-border-default)]'
      )}
    >
      {/* Popup header with sender and close button */}
      {popupMode && (
        <div className="flex items-center justify-between mb-3 -mt-1">
          <span className="text-xs text-muted-foreground">@{message.sender}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-0.5 -mr-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Prompt */}
      <p className="text-base font-medium mb-4">{prompt}</p>

      {isSubmitted ? (
        <>
          <p className="text-xs text-muted-foreground mb-3">
            Submitted{respondedBy ? ` by @${respondedBy}` : ''}
          </p>
          <div className="space-y-4 opacity-50">
            {fields.map((field) => (
              <FieldRenderer
                key={field.name}
                field={field}
                value={response?.[field.name] ?? values[field.name]}
                onChange={() => {}}
                disabled={true}
                spaceId={spaceId}
                apiHost={apiHost}
                roster={roster}
              />
            ))}
          </div>
        </>
      ) : isDismissed ? (
        <>
          <p className="text-xs text-muted-foreground mb-3">
            Dismissed{message.dismissedBy ? ` by @${message.dismissedBy}` : ''}
          </p>
          <div className="space-y-4 opacity-50">
            {fields.map((field) => (
              <FieldRenderer
                key={field.name}
                field={field}
                value={values[field.name]}
                onChange={() => {}}
                disabled={true}
                spaceId={spaceId}
                apiHost={apiHost}
                roster={roster}
              />
            ))}
          </div>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map((field) => (
            <FieldRenderer
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(value) => handleFieldChange(field.name, value)}
              disabled={!canSubmit || isSubmitting}
              spaceId={spaceId}
              apiHost={apiHost}
              roster={roster}
            />
          ))}

          {canSubmit && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onCancel?.(message.id)}
                disabled={isSubmitting}
                className={cn(
                  'px-4 py-2 text-base font-medium',
                  'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors'
                )}
              >
                {cancelLabel || 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className={cn(
                  'px-4 py-2 text-base font-medium',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors'
                )}
              >
                {isSubmitting ? 'Submitting...' : (submitLabel || 'Submit')}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  )
}

interface FieldRendererProps {
  field: StructuredAskField
  value: string | string[] | SummonRequestResponse[]
  onChange: (value: string | string[] | SummonRequestResponse[]) => void
  disabled: boolean
  spaceId?: string
  apiHost?: string
  roster?: { callsign: string; runtimeId?: string | null }[]
}

function FieldRenderer({ field, value, onChange, disabled, spaceId, apiHost, roster }: FieldRendererProps) {
  switch (field.type) {
    case 'radio':
      return (
        <RadioField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'checkbox':
      return (
        <CheckboxField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'select':
      return (
        <SelectField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'text':
      return (
        <TextField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'textarea':
      return (
        <TextareaField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'summon_request':
      return (
        <SummonRequestField
          field={field}
          value={Array.isArray(value) ? value as SummonRequestResponse[] : []}
          onChange={onChange}
          disabled={disabled}
          spaceId={spaceId}
          apiHost={apiHost}
          roster={roster}
        />
      )
    case 'secret':
      return (
        <SecretField
          field={field}
          value={value as string | string[]}
          onChange={onChange}
          disabled={disabled}
        />
      )
    default:
      return null
  }
}
