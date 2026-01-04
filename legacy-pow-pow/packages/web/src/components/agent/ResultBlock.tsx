interface ResultBlockProps {
  content: string
}

export function ResultBlock({ content }: ResultBlockProps) {
  const maxHeight = 200
  const truncateAt = 2000
  const isTruncated = content.length > truncateAt

  return (
    <div className="rounded border border-border bg-secondary/30 overflow-hidden text-xs">
      <pre
        className="px-2 py-1 font-mono whitespace-pre-wrap break-words overflow-y-auto text-muted-foreground"
        style={{ maxHeight }}
      >
        {isTruncated ? content.slice(0, truncateAt) + `\n... (${(content.length - truncateAt).toLocaleString()} more chars)` : content}
      </pre>
    </div>
  )
}
