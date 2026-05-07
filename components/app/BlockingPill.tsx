import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// BlockingPill — PR-2 of the stats redesign.
// ─────────────────────────────────────────────────────────────────────────────
//
// Red-tinted pill rendered at the right end of the Projects Dashboard tile's
// stats row, only when blocking issue count > 0. Replaces the previous
// inline-text "Blocking: N" stat with a visually distinct callout. Q7 in
// PR-2 Stop 1 picked the inline-at-row-end placement.

interface BlockingPillProps {
  /** From `projectStats.blocking` (resolution-suppressed open blocking
   *  count). Component returns null when count <= 0 — the absence of a
   *  pill is the "no blocking issues" signal. */
  count: number
  className?: string
}

export function BlockingPill({ count, className }: BlockingPillProps) {
  if (count <= 0) return null
  return (
    <span
      data-testid='blocking-pill'
      data-count={count}
      className={cn(
        'inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-700 ml-auto',
        className,
      )}
    >
      Blocking: {count}
    </span>
  )
}
