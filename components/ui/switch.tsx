'use client'

// Controlled-only accessible switch primitive (PR 2b).
//
// Used by the org-settings Permissions section to toggle the
// `organizations.member_auto_grant_enabled` flag. Built on a native
// <button role="switch"> so keyboard activation (Space, Enter) and
// `aria-checked` are wired by the platform. No Radix dependency.
//
// Public API (controlled-only): pass `checked` + `onCheckedChange`.
// There is no uncontrolled mode and no forwarded ref — keep the
// surface minimal until a second consumer needs more.

import { cn } from '@/lib/utils/cn'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-settle-teal-500/40 focus-visible:ring-offset-2',
        disabled && 'opacity-50 cursor-not-allowed',
        checked ? 'bg-settle-teal-500' : 'bg-gray-200',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
