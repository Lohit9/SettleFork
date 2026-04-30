'use client'

/**
 * Single-source tooltip copy for role-required disabled controls. Use one
 * of these keys (via the `tooltipKey` prop) instead of passing a custom
 * `requiredRole` string when adding a new gate, so wording stays consistent
 * across the ~80+ disabled-with-tooltip call sites in the app.
 *
 * Today's wording:
 *   editor → "You need Editor access to perform this action"
 *   admin  → "You need Admin access to perform this action"
 *
 * Existing call sites that still pass `requiredRole="Editor"` continue to
 * work — the legacy template renders the same final string for the
 * `editor` case. New call sites should prefer `tooltipKey="editor"` for
 * drift safety.
 */
export const ROLE_TOOLTIP_COPY = {
  editor: 'You need Editor access to perform this action',
  admin: 'You need Admin access to perform this action',
} as const

export type RoleTooltipKey = keyof typeof ROLE_TOOLTIP_COPY

interface RoleTooltipProps {
  children: React.ReactNode
  allowed: boolean
  /**
   * Legacy prop. The role name is interpolated into
   * `"You need {requiredRole} access to perform this action"`. Kept for
   * back-compat with existing call sites — new code should pass
   * `tooltipKey` instead.
   */
  requiredRole?: string
  /**
   * Canonical tooltip-copy lookup. When provided, takes precedence over
   * `requiredRole` and renders the full string from `ROLE_TOOLTIP_COPY`
   * verbatim.
   */
  tooltipKey?: RoleTooltipKey
}

export function RoleTooltip({
  children,
  allowed,
  requiredRole,
  tooltipKey,
}: RoleTooltipProps) {
  if (allowed) return <>{children}</>

  const message = tooltipKey
    ? ROLE_TOOLTIP_COPY[tooltipKey]
    : requiredRole
      ? `You need ${requiredRole} access to perform this action`
      : ROLE_TOOLTIP_COPY.editor

  return (
    <div className="relative group/role-tip inline-flex">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1 bg-gray-900 text-white text-[11px] rounded-md opacity-0 group-hover/role-tip:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
        {message}
      </div>
    </div>
  )
}
