import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import {
  getOrgSsoOverview,
  listOrgSsoDomains,
  listOrgSsoLinkedUsers,
  listOrgSsoAuditEvents,
} from '@/lib/actions/sso-admin'
import { SsoSettingsContent } from './SsoSettingsContent'

// Org-admin SSO settings page (B-2-c-i).
//
// RSC entry point: resolves the active org from cookies, gates on
// admin role, fetches the four data sources in parallel, and hands
// them to a Client Component for rendering.
//
// Two layers of authorization run here, by design:
//
//   1. THIS file does an early role check (lines 84-94) and renders
//      a friendly "you need admin role" panel for non-admins instead
//      of a generic error toast. This is purely UX — no security
//      decision is made on the result.
//
//   2. EACH server action inside `lib/actions/sso-admin.ts` runs its
//      OWN `requireOrgAdmin(orgId)` check before any DB access. That
//      is the load-bearing security boundary. The page-level check
//      could be bypassed (e.g. by hitting the action endpoint
//      directly via a crafted POST) without breaking isolation,
//      because the action would still reject.
//
// Cookie names: both `settle-active-org` and `mine-active-org` are
// honored. The codebase has used both names at different points in
// time; existing pages (`app/app/settings/page.tsx:34-37`,
// `app/app/settings/organization/page.tsx:14-16`) read both with
// fall-through. We match that pattern.

export const dynamic = 'force-dynamic'

export default async function SsoSettingsPage() {
  const cookieStore = await cookies()
  const activeOrgIdFromCookie =
    cookieStore.get('settle-active-org')?.value ??
    cookieStore.get('mine-active-org')?.value ??
    null

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?redirect=/app/settings/sso')

  // Resolve `orgId` for this page.
  //
  // Preference order:
  //   1. The active-org cookie, IF the user actually has a membership
  //      in that org. (We must verify; a stale cookie pointing at an
  //      org the user no longer belongs to would otherwise pin the
  //      page to a "not_member" state.)
  //   2. The user's first owner/admin membership — most useful first
  //      view for someone signing in to manage SSO.
  //   3. Their first membership of any role, so the page still
  //      renders something coherent.
  const { data: memberships } = await supabase
    .from('org_memberships')
    .select('org_id, role, joined_at')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })

  if (!memberships || memberships.length === 0) {
    return (
      <div className="px-8 py-6">
        <div className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
          You are not a member of any organization yet.
        </div>
      </div>
    )
  }

  const cookieMembership = activeOrgIdFromCookie
    ? memberships.find((m) => m.org_id === activeOrgIdFromCookie)
    : undefined
  const adminMembership = memberships.find(
    (m) => m.role === 'owner' || m.role === 'admin',
  )
  const activeMembership = cookieMembership ?? adminMembership ?? memberships[0]
  const orgId = activeMembership.org_id
  const role = activeMembership.role

  // UX gate: render a friendly "needs admin role" panel for viewers
  // and editors. The actions also enforce this server-side; this is
  // just nicer than letting four cards render their auth-error
  // states.
  const isAdmin = role === 'owner' || role === 'admin'
  if (!isAdmin) {
    return (
      <div className="px-8 py-6 max-w-3xl">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <p className="font-medium">Admin access required</p>
          <p className="mt-1 text-amber-700">
            You need to be an organization owner or admin to view SSO
            settings. Ask your org admin if you need access.
          </p>
        </div>
      </div>
    )
  }

  // Parallel fetch — all four reads independent. Keeps the slowest
  // call (typically the audit-events query, since it pulls the most
  // rows) on the critical path rather than serializing.
  const [overview, domains, linkedUsers, auditEvents] = await Promise.all([
    getOrgSsoOverview(orgId),
    listOrgSsoDomains(orgId),
    listOrgSsoLinkedUsers(orgId),
    listOrgSsoAuditEvents(orgId, 50),
  ])

  return (
    <SsoSettingsContent
      orgId={orgId}
      overview={overview}
      domains={domains}
      linkedUsers={linkedUsers}
      auditEvents={auditEvents}
      // `canEdit` reuses the same isAdmin computation that drove
      // the role-gate above (line 94). One source of truth: if the
      // page rendered (i.e. isAdmin was true), the user can edit.
      // Viewers/editors never reach this branch.
      canEdit={isAdmin}
    />
  )
}
