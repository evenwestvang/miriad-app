import React, { useState, useRef } from 'react'
import { FileText, Plus, Trash2 } from 'lucide-react'
import { Button } from './button'
import { EditableField } from './editable-field'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './alert-dialog'
import { cn } from '@/lib/utils'

export interface DocItem {
  id: string
  name: string
  content: string
}

interface DocListProps {
  items: DocItem[]
  onChange: (items: DocItem[]) => void
  singularName: string
  pluralName: string
  description?: string
  contentLabel?: string
  contentPlaceholder?: string
  icon?: React.ReactNode
}

export function DocList({
  items,
  onChange,
  singularName,
  pluralName,
  description,
  contentLabel = 'Content',
  contentPlaceholder = 'Click to add content...',
  icon,
}: DocListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const selectedItem = items.find(item => item.id === selectedId) || null

  const handleAdd = () => {
    const newItem: DocItem = {
      id: crypto.randomUUID(),
      name: '',
      content: '',
    }
    onChange([...items, newItem])
    setSelectedId(newItem.id)
  }

  const handleSelect = (item: DocItem) => {
    setSelectedId(item.id)
  }

  const handleUpdateName = (name: string) => {
    if (!selectedId) return
    onChange(items.map(item =>
      item.id === selectedId ? { ...item, name } : item
    ))
  }

  const handleUpdateContent = (content: string) => {
    if (!selectedId) return
    onChange(items.map(item =>
      item.id === selectedId ? { ...item, content } : item
    ))
  }

  const handleDelete = (id: string) => {
    onChange(items.filter(item => item.id !== id))
    if (selectedId === id) {
      setSelectedId(null)
    }
    setDeleteConfirmId(null)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{pluralName}</h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <Button onClick={handleAdd} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add {singularName}
        </Button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* List */}
        <div className="w-64 border-r overflow-y-auto">
          {items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No {pluralName.toLowerCase()} yet
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {items.map(item => (
                <div
                  key={item.id}
                  className={cn(
                    'group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer',
                    selectedId === item.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
                  )}
                  onClick={() => handleSelect(item)}
                >
                  {icon || <FileText className="h-4 w-4 shrink-0" />}
                  <span className={cn('flex-1 truncate', !item.name && 'italic text-muted-foreground')}>
                    {item.name || 'Untitled'}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteConfirmId(item.id)
                    }}
                    className={cn(
                      'opacity-0 group-hover:opacity-100 p-0.5 rounded',
                      selectedId === item.id ? 'hover:bg-primary-foreground/20' : 'hover:bg-destructive/20'
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preview/Editor */}
        <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
          {selectedItem ? (
            <div className="p-6 space-y-6 max-w-3xl">
              <EditableField
                label="Name"
                value={selectedItem.name}
                onChange={handleUpdateName}
                placeholder="Enter name..."
                inputClassName="text-lg font-semibold"
                previewClassName="text-lg font-semibold"
              />
              <EditableField
                label={contentLabel}
                value={selectedItem.content}
                onChange={handleUpdateContent}
                placeholder={contentPlaceholder}
                multiline
                minHeight="min-h-[200px]"
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              Select a {singularName.toLowerCase()} to view
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {singularName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The {singularName.toLowerCase()} will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
