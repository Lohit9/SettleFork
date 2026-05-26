'use client'

import { useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/components/ui/utils'

interface CollapsibleTextProps {
  text: string
  threshold?: number
  renderContent?: (displayText: string) => ReactNode
  className?: string
  testId?: string
}

export function CollapsibleText({
  text,
  threshold = 400,
  renderContent,
  className,
  testId,
}: CollapsibleTextProps) {
  const [expanded, setExpanded] = useState(false)

  const needsTruncation = text.length > threshold
  const displayText =
    needsTruncation && !expanded
      ? text.slice(0, lastWordBoundary(text, threshold)).trimEnd() + '…'
      : text

  const content = renderContent ? (
    renderContent(displayText)
  ) : (
    <p className={cn('whitespace-pre-wrap text-sm text-slate-700', className)}>
      {displayText}
    </p>
  )

  return (
    <div
      data-testid={testId}
      className={renderContent ? className : undefined}
    >
      <motion.div
        layout
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        {content}
      </motion.div>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          data-testid={testId ? `${testId}-toggle` : undefined}
          className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-slate-700"
        >
          {expanded ? 'Show less' : 'Read more'}
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </button>
      )}
    </div>
  )
}

// Trim to the last whitespace at-or-before `max` so we never cut mid-word.
// Falls back to a hard cut at `max` if no whitespace exists before then
// (e.g. a single 500-char token — rare in prose, possible in long URLs).
//
// Walks backward instead of regex-matching because `/^.*\s/` is anchored to
// a single line (`.` excludes `\n`), which made truncation snap to the first
// paragraph break instead of the threshold — e.g. a 405-char rationale
// starting "Field type: Text(50), Required.\n\n…" truncated to ~32 chars.
function lastWordBoundary(text: string, max: number): number {
  if (text.length <= max) return text.length
  for (let i = max; i > 0; i--) {
    if (/\s/.test(text[i])) return i
  }
  return max
}
