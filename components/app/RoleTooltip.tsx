'use client'

interface RoleTooltipProps {
  children: React.ReactNode
  allowed: boolean
  requiredRole: string
}

export function RoleTooltip({ children, allowed, requiredRole }: RoleTooltipProps) {
  if (allowed) return <>{children}</>
  return (
    <div className="relative group/role-tip inline-flex">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1 bg-gray-900 text-white text-[11px] rounded-md opacity-0 group-hover/role-tip:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
        You need {requiredRole} access to perform this action
      </div>
    </div>
  )
}
