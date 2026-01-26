import { Shield } from 'lucide-react'
import { cn } from '../../lib/utils'
import type {
  RadioField as RadioFieldType,
  CheckboxField as CheckboxFieldType,
  SelectField as SelectFieldType,
  TextField as TextFieldType,
  TextareaField as TextareaFieldType,
  SecretField as SecretFieldType,
} from '../../types'

interface FieldProps<T> {
  field: T
  value: string | string[]
  onChange: (value: string | string[]) => void
  disabled?: boolean
}

function FieldLabel({ field }: { field: { label: string; description?: string; required?: boolean } }) {
  return (
    <div className="mb-2">
      <label className="text-base font-medium text-foreground">
        {field.label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
      )}
    </div>
  )
}

export function RadioField({ field, value, onChange, disabled }: FieldProps<RadioFieldType>) {
  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      <div className="space-y-1.5">
        {field.options.map((option) => (
          <label
            key={option}
            className={cn(
              'flex items-center gap-2 cursor-pointer',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            <input
              type="radio"
              name={field.name}
              value={option}
              checked={value === option}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              className="h-4 w-4 text-primary border-border focus:ring-primary"
            />
            <span className="text-base">{option}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export function CheckboxField({ field, value, onChange, disabled }: FieldProps<CheckboxFieldType>) {
  const selectedValues = Array.isArray(value) ? value : []

  const handleChange = (option: string, checked: boolean) => {
    if (checked) {
      onChange([...selectedValues, option])
    } else {
      onChange(selectedValues.filter((v) => v !== option))
    }
  }

  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      <div className="space-y-1.5">
        {field.options.map((option) => (
          <label
            key={option}
            className={cn(
              'flex items-center gap-2 cursor-pointer',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            <input
              type="checkbox"
              value={option}
              checked={selectedValues.includes(option)}
              onChange={(e) => handleChange(option, e.target.checked)}
              disabled={disabled}
              className="h-4 w-4 rounded text-primary border-border focus:ring-primary"
            />
            <span className="text-base">{option}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export function SelectField({ field, value, onChange, disabled }: FieldProps<SelectFieldType>) {
  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          'w-full px-3 py-2 text-base rounded-md border border-border bg-background',
          'focus:outline-none focus:ring-1 focus:ring-primary',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <option value="">Select...</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  )
}

export function TextField({ field, value, onChange, disabled }: FieldProps<TextFieldType>) {
  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        className={cn(
          'w-full px-3 py-2 text-base rounded-md border border-border bg-background',
          'focus:outline-none focus:ring-1 focus:ring-primary',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      />
    </div>
  )
}

export function TextareaField({ field, value, onChange, disabled }: FieldProps<TextareaFieldType>) {
  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      <textarea
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        rows={3}
        className={cn(
          'w-full px-3 py-2 text-base rounded-md border border-border bg-background resize-y',
          'focus:outline-none focus:ring-1 focus:ring-primary',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      />
    </div>
  )
}

export function SecretField({ field, value, onChange, disabled }: FieldProps<SecretFieldType>) {
  // For submitted/dismissed forms, show placeholder instead of actual value
  const displayValue = value === '<secret encrypted>' ? '' : (typeof value === 'string' ? value : '')
  const isEncrypted = value === '<secret encrypted>'
  
  return (
    <div className="space-y-2">
      <FieldLabel field={field} />
      {isEncrypted ? (
        <div className="w-full px-3 py-2 text-base rounded-md border border-border bg-muted text-muted-foreground italic">
          &lt;secret encrypted&gt;
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <Shield className="w-3.5 h-3.5" />
            <span>This value will be encrypted and never shown in chat</span>
          </div>
          <input
            type="password"
            value={displayValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? 'Enter secret value...'}
            disabled={disabled}
            autoComplete="off"
            className={cn(
              'w-full px-3 py-2 text-base rounded-md border border-border bg-background',
              'focus:outline-none focus:ring-1 focus:ring-primary',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          />
        </>
      )}
      <div className="text-xs text-muted-foreground">
        → {field.targetKey} on {field.targetSlug} in #{field.targetChannel}
      </div>
    </div>
  )
}
