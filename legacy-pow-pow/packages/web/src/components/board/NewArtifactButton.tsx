import { useState, useCallback, useEffect, useRef } from 'react'
import { Plus, FileText, Code, CheckSquare, Bot, BookOpen, Target, Library, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface NewArtifactButtonProps {
  onCreate: (type: string, slug: string, title: string, parentSlug?: string | null) => void
  pendingAdd?: { parentSlug: string | null; orderKey: string } | null
  onClose?: () => void
  hasKnowledgebase?: boolean
}

const ARTIFACT_TYPES = [
  { id: 'task', label: 'Task', icon: CheckSquare },
  { id: 'doc', label: 'Document', icon: FileText },
  { id: 'code', label: 'Code', icon: Code },
  { id: 'knowledgebase', label: 'Knowledge Base', icon: Library },
  { id: 'system.agent', label: 'Agent Definition', icon: Bot },
  { id: 'system.playbook', label: 'Playbook', icon: BookOpen },
  { id: 'system.focus', label: 'Focus', icon: Target },
  { id: 'system.mcp', label: 'MCP Server', icon: Plug },
]

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function NewArtifactButton({ onCreate, pendingAdd, onClose, hasKnowledgebase = false }: NewArtifactButtonProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'type' | 'details'>('type')
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Filter out knowledgebase if one already exists
  const availableTypes = hasKnowledgebase
    ? ARTIFACT_TYPES.filter(t => t.id !== 'knowledgebase')
    : ARTIFACT_TYPES

  // Auto-open when pendingAdd is set
  useEffect(() => {
    if (pendingAdd) {
      setOpen(true)
    }
  }, [pendingAdd])

  // Auto-generate slug from name unless manually edited
  useEffect(() => {
    if (!slugEdited && name) {
      setSlug(generateSlug(name))
    }
  }, [name, slugEdited])

  const handleTypeSelect = (type: string) => {
    // Knowledgebase: create directly without dialog (slug must be 'knowledgebase')
    if (type === 'knowledgebase') {
      onCreate('knowledgebase', 'knowledgebase', 'Knowledge Base', pendingAdd?.parentSlug)
      setOpen(false)
      resetState()
      onClose?.()
      return
    }
    setSelectedType(type)
    setStep('details')
    // Focus name input after render
    setTimeout(() => nameInputRef.current?.focus(), 0)
  }

  const handleSlugChange = (value: string) => {
    setSlugEdited(true)
    setSlug(value)
  }

  const resetState = useCallback(() => {
    setStep('type')
    setSelectedType(null)
    setName('')
    setSlug('')
    setSlugEdited(false)
  }, [])

  const handleCreate = useCallback(() => {
    if (!selectedType || !name.trim() || !slug.trim()) return
    onCreate(selectedType, slug.trim(), name.trim(), pendingAdd?.parentSlug)
    setOpen(false)
    resetState()
    onClose?.()
  }, [selectedType, name, slug, onCreate, pendingAdd, resetState, onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || step === 'details')) {
      e.preventDefault()
      handleCreate()
    }
    if (e.key === 'Escape') {
      if (step === 'details') {
        resetState()
      } else {
        setOpen(false)
        onClose?.()
      }
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      resetState()
      onClose?.()
    }
  }

  const canCreate = selectedType && name.trim() && slug.trim()

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-2"
        onKeyDown={handleKeyDown}
      >
        {step === 'type' ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground px-2 py-1">
              New artifact
              {pendingAdd?.parentSlug && (
                <span className="text-primary ml-1">(child)</span>
              )}
            </div>
            {availableTypes.map((type) => (
              <button
                key={type.id}
                onClick={() => handleTypeSelect(type.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-secondary text-left'
                )}
              >
                <type.icon className="h-4 w-4 text-muted-foreground" />
                {type.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground px-1">
              {availableTypes.find(t => t.id === selectedType)?.icon && (
                (() => {
                  const Icon = availableTypes.find(t => t.id === selectedType)!.icon
                  return <Icon className="h-3 w-3" />
                })()
              )}
              New {availableTypes.find(t => t.id === selectedType)?.label}
            </div>
            <div className="space-y-2">
              <Input
                ref={nameInputRef}
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-sm"
              />
              <Input
                placeholder="slug"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                className={cn(
                  'h-8 text-sm font-mono text-xs',
                  !slugEdited && 'text-muted-foreground'
                )}
              />
            </div>
            <div className="flex justify-between items-center pt-1">
              <button
                onClick={resetState}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Back
              </button>
              <Button
                size="sm"
                disabled={!canCreate}
                onClick={handleCreate}
                className="h-7 text-xs"
              >
                Create
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground text-center">
              Press <kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">Cmd</kbd>+<kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">Enter</kbd> to create
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
