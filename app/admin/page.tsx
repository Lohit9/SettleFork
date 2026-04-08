import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import AdminContent, { AccessRequest, OrgRow } from './AdminContent'

const ADMIN_EMAILS = ['kaandincer1@gmail.com']

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || !ADMIN_EMAILS.includes(user.email ?? '')) {
    redirect('/')
  }

  // ── Fetch access requests ─────────────────────────────────────────────────
  const { data: rawRequests } = await supabaseAdmin
    .from('access_requests')
    .select('*')
    .order('created_at', { ascending: false })

  const requests: AccessRequest[] = (rawRequests ?? []) as AccessRequest[]

  // ── Fetch organizations ───────────────────────────────────────────────────
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

  const orgs: OrgRow[] = (rawOrgs ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    created_at: o.created_at,
    member_count: memberCounts[o.id] ?? 0,
    project_count: projectCounts[o.id] ?? 0,
  }))

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Slim top bar — just logo + admin badge */}
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <Link href="/">
            <img src="/images/logos/settle-logo-full.svg" alt="Settle" className="h-7 w-auto" />
          </Link>
          <span className="text-xs font-semibold bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
            Admin
          </span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        <AdminContent requests={requests} orgs={orgs} adminEmail={user.email ?? ''} />
      </main>
    </div>
  )
}
