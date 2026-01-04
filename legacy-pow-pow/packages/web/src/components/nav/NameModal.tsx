import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface NameModalProps {
  onSubmit: (name: string) => void
}

export function NameModal({ onSubmit }: NameModalProps) {
  const [name, setName] = useState('')

  return (
    <Dialog open={true}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to <span className="text-orange-500">CAST</span></DialogTitle>
          <DialogDescription>
            Choose a name to identify yourself in chat.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., swift-fox"
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit(name.trim())}
            autoFocus
          />
          <Button
            onClick={() => name.trim() && onSubmit(name.trim())}
            disabled={!name.trim()}
            className="w-full"
          >
            Join Chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
