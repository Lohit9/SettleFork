'use client'

import { useEffect, useCallback } from 'react'

interface FixDrawerProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
}

export function FixDrawer({ isOpen, onClose, children }: FixDrawerProps) {

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [isOpen, handleKeyDown])

  return (
    <>
      {/* Backdrop — click to close */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-slate-900/20 transition-opacity
                    duration-200 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        className={`fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col
                    bg-white border-l border-settle-slate-200 shadow-xl
                    transition-transform duration-200 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {children}
      </div>
    </>
  )
}
