import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import MembersContent from './MembersContent'

export default async function MembersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Resolve active org from cookie or first membership
  const { data: memberships } = await supabase
    .from('org_memberships')
    .select('org_id, role')
    .eq('user_id', user.id)

  if (!memberships || memberships.length === 0) {
    redirect('/app/projects')
  }

  // Try to read the cookie server-side
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  const cookieOrgId = cookieStore.get('mine-active-org')?.value
  const activeOrg = memberships.find((m) => m.org_id === cookieOrgId) ?? memberships[0]

  return (
    <div className="flex-1 bg-gray-50 min-h-screen">
        <div className="border-b border-gray-200 bg-white">
          <div className="px-8 py-5 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage your account and preferences</p>
            </div>
            <form action={signOut}>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400 text-sm"
              >
                Sign out
              </Button>
            </form>
          </div>
          <div className="px-8 flex gap-6">
            <a
              href="/app/settings"
              className="pb-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent"
            >
              General
            </a>
            <a
              href="/app/settings/members"
              className="pb-2.5 text-sm font-medium text-blue-600 border-b-2 border-blue-600"
            >
              Members
            </a>
          </div>
        </div>

        <div className="px-8 py-6 max-w-4xl">
          <MembersContent
            orgId={activeOrg.org_id}
            currentUserId={user.id}
            currentUserRole={activeOrg.role as 'owner' | 'admin' | 'editor' | 'viewer'}
          />
        </div>
      </div>
  )
}
