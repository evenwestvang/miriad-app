import { cn } from '../../lib/utils'

interface SegmentedControlOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  label?: string
  value: T
  onChange: (value: T) => void
  options: SegmentedControlOption<T>[]
  className?: string
}

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: SegmentedControlProps<T>) {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault()
      onChange(options[index - 1].value)
    }
    if (e.key === 'ArrowRight' && index < options.length - 1) {
      e.preventDefault()
      onChange(options[index + 1].value)
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <label className="block text-xs font-medium text-muted-foreground uppercase">
          {label}
        </label>
      )}
      <div
        className="inline-flex rounded-md border bg-secondary/30 p-1"
        role="radiogroup"
        aria-label={label}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={value === option.value}
            tabIndex={value === option.value ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'px-3 py-1.5 text-base font-medium transition-colors',
              'focus:outline-none focus-visible:ring-0',
              value === option.value
                ? 'bg-secondary text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
