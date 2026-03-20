'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, HelpCircle, Profile } from '@/components/icons'
import { Button } from '@/components/ui/button'

interface SidebarShellProps {
  children: React.ReactNode
}

export default function SidebarShell({ children }: SidebarShellProps) {
  const pathname = usePathname()
  
  // Determine active states
  // Home is active on /app/projects (the main projects list page)
  const isHomeActive = pathname === '/app/projects' || pathname === '/app'
  const isSupportActive = pathname === '/app/support'
  const isProfileActive = pathname === '/app/profile'

  return (
    <div className="h-screen w-full flex bg-[#111111] overflow-hidden">
      <div className="w-14 bg-[#0a0a0a] border-r border-[#1e1e1e] flex flex-col h-screen flex-shrink-0">
        <div className="p-3 border-b border-[#1e1e1e] flex-shrink-0 flex items-center justify-center">
          <Link href="/app/projects" className="w-9 h-9 bg-[#4F46E5] rounded-lg flex items-center justify-center hover:bg-[#4338CA] transition-colors">
            <span className="text-white font-bold text-base">M</span>
          </Link>
        </div>

        <div className="flex-1 min-h-0" />

        <div className="border-t border-[#1e1e1e] flex-shrink-0 p-2">
          <div className="space-y-1">
            <Link href="/app/projects" title="Home">
              <Button
                variant="ghost"
                size="sm"
                className={`w-full h-9 p-0 flex items-center justify-center rounded-lg transition-colors ${
                  isHomeActive
                    ? 'bg-[#4F46E5] text-white hover:bg-[#4338CA]'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-[#1e1e1e]'
                }`}
              >
                <Home className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/app/support" title="Support">
              <Button
                variant="ghost"
                size="sm"
                className={`w-full h-9 p-0 flex items-center justify-center rounded-lg transition-colors ${
                  isSupportActive
                    ? 'bg-[#4F46E5] text-white hover:bg-[#4338CA]'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-[#1e1e1e]'
                }`}
              >
                <HelpCircle className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/app/profile" title="Settings">
              <Button
                variant="ghost"
                size="sm"
                className={`w-full h-9 p-0 flex items-center justify-center rounded-lg transition-colors ${
                  isProfileActive
                    ? 'bg-[#4F46E5] text-white hover:bg-[#4338CA]'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-[#1e1e1e]'
                }`}
              >
                <Profile className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto min-w-0">{children}</div>
    </div>
  )
}
