'use client'

import { useEffect } from 'react'

// Generic modal shell — fixed-position black overlay with a centered white
// card. Closing affordances: click outside the card, press Escape, or call
// `onClose` from a child (e.g. a Cancel button). The shell is intentionally
// thin so callers retain full control over the body markup; only the title
// row and the chrome are managed here.
//
// Originally inlined inside `components/app/ProjectMenu.tsx` (PR-pre-2a) and
// lifted here in PR 2a so the project-settings flow (Add Member, Confirm
// Remove, etc.) can share the same shell instead of recopying the ~25 LOC
// at every modal site. Behavior matches the original byte-for-byte; the
// only intentional difference is the public location.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose?: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[300] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}
