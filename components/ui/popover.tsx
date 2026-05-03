"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "./utils"

// Shadcn-style wrapper around @radix-ui/react-popover. Mirrors the conventions
// established by components/ui/select.tsx (PR pre-D) and
// components/ui/dropdown-menu.tsx (PR #31): named function exports per
// primitive, data-slot attributes, cn() className composition, Radix primitive
// aliased as `* as PopoverPrimitive`. Default-prop choices on Content
// (align="center", sideOffset={4}, collisionPadding={8}) match Radix's natural
// popover defaults — most consumers anchor below their trigger and Radix's
// collision detection handles viewport edges automatically.
//
// PopoverClose is exposed so consumers with action-content (e.g., a Sign Out
// button or a navigation Link inside the popover) can wrap those elements with
// asChild and get auto-close-on-click. Radix Popover does NOT auto-close on
// arbitrary content clicks — only on Trigger toggle, Esc, or outside-click.

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
    />
  )
}

function PopoverPortal({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Portal>) {
  return (
    <PopoverPrimitive.Portal
      data-slot="popover-portal"
      {...props}
    />
  )
}

function PopoverClose({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return (
    <PopoverPrimitive.Close
      data-slot="popover-close"
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-[200] min-w-[8rem] overflow-hidden rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg outline-none",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
        "data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2",
        className,
      )}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
}
