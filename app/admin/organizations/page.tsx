import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import AdminOrgsContent from './AdminOrgsContent'

const ADMIN_EMAILS = ['kaandincer1@gmail.com']

export const dynamic = 'force-dynamic'

export default async function AdminOrganizationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || !ADMIN_EMAILS.includes(user.email ?? '')) {
    redirect('/')
  }

  const { data: rawOrgs } = await supabaseAdmin
    .from('organizations')
    .select('*')
    .order('created_at', { ascending: false })

  const orgIds = (rawOrgs ?? []).map((o) => o.id)

  const [{ data: memberships }, { data: projects }] = await Promise.all([
    supabaseAdmin
      .from('org_memberships')
      .select('org_id')
      .in('org_id', orgIds.length > 0 ? orgIds : ['none']),
    supabaseAdmin
      .from('projects')
      .select('org_id')
      .in('org_id', orgIds.length > 0 ? orgIds : ['none']),
  ])

  const memberCounts: Record<string, number> = {}
  for (const m of memberships ?? []) {
    memberCounts[m.org_id] = (memberCounts[m.org_id] ?? 0) + 1
  }

  const projectCounts: Record<string, number> = {}
  for (const p of projects ?? []) {
    if (p.org_id) projectCounts[p.org_id] = (projectCounts[p.org_id] ?? 0) + 1
  }

  const orgs = (rawOrgs ?? []).map((o) => ({
    ...o,
    member_count: memberCounts[o.id] ?? 0,
    project_count: projectCounts[o.id] ?? 0,
  }))

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <img src="/Mine Logo no background.png" alt="Mine" className="h-7 w-auto" />
            </Link>
            <span className="text-xs font-semibold bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <Link href="/admin/invites" className="text-gray-600 hover:text-gray-900 font-medium">
              Invites
            </Link>
            <span className="text-blue-600 font-medium">Organizations</span>
            <span className="text-gray-300">|</span>
            <span>{user.email}</span>
            <Link href="/app/projects" className="text-blue-600 hover:text-blue-700 font-medium">
              Go to app →
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-7">
          <h1 className="text-xl font-semibold text-gray-900">Organizations</h1>
          <p className="text-sm text-gray-500 mt-0.5">Create and manage organizations, members, and invites.</p>
        </div>
        <AdminOrgsContent initialOrgs={orgs} />
      </main>
    </div>
  )
}
