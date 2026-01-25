import { useRef, useEffect } from 'react'
import { cn } from '../../lib/utils'

interface EditableFieldProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  multiline?: boolean
  minHeight?: string
  className?: string
  inputClassName?: string
}

/**
 * Simple controlled input field - no internal save/cancel logic.
 * Parent component handles save via form-level Save button.
 */
export function EditableField({
  value,
  onChange,
  label,
  placeholder = 'Enter value...',
  multiline = false,
  minHeight,
  className,
  inputClassName,
}: EditableFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [value, multiline])

  const inputClasses = cn(
    'w-full px-2 py-1.5 text-base bg-secondary border border-border',
    'focus:outline-none focus:ring-0 focus:border-foreground',
    multiline && 'font-mono resize-none overflow-hidden',
    minHeight || (multiline && 'min-h-[100px]'),
    inputClassName
  )

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          {label}
        </label>
      )}
      {multiline ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClasses}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClasses}
        />
      )}
    </div>
  )
}
