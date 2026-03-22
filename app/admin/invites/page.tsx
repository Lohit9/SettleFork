import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import AdminInvitesContent, { AccessRequest, Invite } from './AdminInvitesContent'

const ADMIN_EMAILS = ['kaandincer1@gmail.com']

export const dynamic = 'force-dynamic'

export default async function AdminInvitesPage() {
  // ── Auth check ────────────────────────────────────────────────────────────
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

  // ── Fetch invites ─────────────────────────────────────────────────────────
  const { data: rawInvites } = await supabaseAdmin
    .from('invites')
    .select('*')
    .order('created_at', { ascending: false })

  // Resolve used_by emails via admin auth
  const usedByIds = (rawInvites ?? [])
    .filter((inv) => inv.used_by)
    .map((inv) => inv.used_by as string)

  const emailMap: Record<string, string> = {}
  if (usedByIds.length > 0) {
    // Fetch up to 1000 users (sufficient for early access scale)
    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    for (const u of authUsers?.users ?? []) {
      if (usedByIds.includes(u.id)) {
        emailMap[u.id] = u.email ?? u.id
      }
    }
  }

  const invites: Invite[] = (rawInvites ?? []).map((inv) => ({
    ...inv,
    used_by_email: inv.used_by ? (emailMap[inv.used_by] ?? null) : null,
  })) as Invite[]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
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
            <span>{user.email}</span>
            <Link
              href="/app/projects"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              Go to app →
            </Link>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-7">
          <h1 className="text-xl font-semibold text-gray-900">Invite Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage early access requests and invite codes.
          </p>
        </div>

        <AdminInvitesContent
          requests={requests}
          invites={invites}
          adminEmail={user.email ?? ''}
        />
      </main>
    </div>
  )
}
