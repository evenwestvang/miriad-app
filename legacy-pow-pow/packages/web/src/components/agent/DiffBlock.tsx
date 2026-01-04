import React from 'react'
import * as Diff from 'diff'

interface DiffBlockProps {
  oldStr: string
  newStr: string
}

export function DiffBlock({ oldStr, newStr }: DiffBlockProps) {
  const diff = Diff.diffLines(oldStr, newStr)

  return (
    <div className="font-mono text-xs overflow-hidden">
      {diff.map((part, i) => {
        if (part.added) {
          return part.value.split('\n').filter((line, idx, arr) => idx < arr.length - 1 || line).map((line, j) => (
            <div key={`${i}-${j}`} className="bg-green-500/15 text-green-600 px-2">
              <span className="select-none text-green-500 mr-2">+</span>{line || ' '}
            </div>
          ))
        }
        if (part.removed) {
          return part.value.split('\n').filter((line, idx, arr) => idx < arr.length - 1 || line).map((line, j) => (
            <div key={`${i}-${j}`} className="bg-red-500/15 text-red-600 px-2">
              <span className="select-none text-red-500 mr-2">-</span>{line || ' '}
            </div>
          ))
        }
        // Context lines - unchanged
        const lines = part.value.split('\n').filter((line, idx, arr) => idx < arr.length - 1 || line)
        // Show max 2 context lines at start/end
        if (lines.length > 4) {
          const start = lines.slice(0, 2)
          const end = lines.slice(-2)
          return (
            <React.Fragment key={i}>
              {start.map((line, j) => (
                <div key={`${i}-s-${j}`} className="text-muted-foreground px-2">
                  <span className="select-none mr-2"> </span>{line || ' '}
                </div>
              ))}
              <div className="text-muted-foreground/50 px-2 text-center">
                ... {lines.length - 4} unchanged lines ...
              </div>
              {end.map((line, j) => (
                <div key={`${i}-e-${j}`} className="text-muted-foreground px-2">
                  <span className="select-none mr-2"> </span>{line || ' '}
                </div>
              ))}
            </React.Fragment>
          )
        }
        return lines.map((line, j) => (
          <div key={`${i}-${j}`} className="text-muted-foreground px-2">
            <span className="select-none mr-2"> </span>{line || ' '}
          </div>
        ))
      })}
    </div>
  )
}
