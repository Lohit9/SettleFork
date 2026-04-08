import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import SidebarShell from '@/components/app/SidebarShell'
import '../globals.css'
import type { OrgRole } from '@/lib/types/organizations'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?redirect=' + encodeURIComponent('/app/projects'))
  }

  // Fetch orgs server-side — eliminates client round-trip on every page load
  const { data: memberships } = await supabase
    .from('org_memberships')
    .select('role, organizations(id, name, slug, created_at, created_by)')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })

  const orgs = ((memberships ?? []) as any[])
    .filter((m) => m.organizations)
    .map((m) => ({
      id: m.organizations.id as string,
      name: m.organizations.name as string,
      slug: m.organizations.slug as string,
      created_at: m.organizations.created_at as string,
      created_by: m.organizations.created_by as string,
      role: m.role as OrgRole,
    }))

  // Resolve active org from cookie — same logic previously done client-side
  const cookieStore = await cookies()
  const cookieOrgId = cookieStore.get('settle-active-org')?.value
    ?? cookieStore.get('mine-active-org')?.value
  const resolvedActiveOrgId =
    (cookieOrgId && orgs.some((o) => o.id === cookieOrgId) ? cookieOrgId : null) ??
    orgs.find((o) => o.role === 'owner')?.id ??
    orgs[0]?.id ??
    null

  const userName = (user.user_metadata?.full_name as string | undefined) ?? user.email?.split('@')[0] ?? ''
  const userEmail = user.email ?? ''

  return (
    <SidebarShell
      initialOrgs={orgs}
      initialActiveOrgId={resolvedActiveOrgId}
      initialUserName={userName}
      initialUserEmail={userEmail}
    >
      {children}
    </SidebarShell>
  )
}
