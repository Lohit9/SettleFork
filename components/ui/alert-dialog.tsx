'use client'

import * as React from 'react'
import { cn } from './utils'

// ── Root ──────────────────────────────────────────────────────────────────────

interface AlertDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  if (!open) return null
  return (
    <AlertDialogPortal onClose={() => onOpenChange?.(false)}>
      {children}
    </AlertDialogPortal>
  )
}

// ── Portal / Overlay ──────────────────────────────────────────────────────────

function AlertDialogPortal({
  onClose,
  children,
}: {
  onClose: () => void
  children?: React.ReactNode
}) {
  // Trap focus and handle Escape key
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 animate-in fade-in-0"
        aria-hidden="true"
        onClick={onClose}
      />
      {children}
    </div>
  )
}

// ── Content ───────────────────────────────────────────────────────────────────

function AlertDialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      className={cn(
        'relative z-50 w-full max-w-md rounded-lg bg-white shadow-xl',
        'animate-in fade-in-0 zoom-in-95',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      {children}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

function AlertDialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1.5 px-6 pt-6 pb-4', className)}
      {...props}
    />
  )
}

// ── Footer ────────────────────────────────────────────────────────────────────

function AlertDialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 px-6 pb-6 pt-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}

// ── Title ─────────────────────────────────────────────────────────────────────

function AlertDialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-base font-semibold text-gray-900', className)}
      {...props}
    />
  )
}

// ── Description ───────────────────────────────────────────────────────────────

function AlertDialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('text-sm text-gray-500 leading-relaxed', className)}
      {...props}
    />
  )
}

// ── Action ────────────────────────────────────────────────────────────────────

function AlertDialogAction({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium cursor-pointer',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'bg-gray-900 text-white hover:bg-gray-800 focus-visible:ring-gray-900',
        className,
      )}
      {...props}
    />
  )
}

// ── Cancel ────────────────────────────────────────────────────────────────────

function AlertDialogCancel({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium cursor-pointer',
        'border border-gray-300 bg-white text-gray-700',
        'transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400',
        className,
      )}
      {...props}
    />
  )
}

// ── Trigger (no-op stub for API compatibility) ────────────────────────────────

function AlertDialogTrigger({
  children,
}: {
  children?: React.ReactNode
  asChild?: boolean
}) {
  return <>{children}</>
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
