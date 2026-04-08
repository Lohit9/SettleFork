import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getInviteByToken } from '@/lib/actions/org-invites'
import InviteClient from './InviteClient'

interface Props {
  params: { token: string }
}

export default async function InvitePage({ params }: Props) {
  const { token } = params
  const { invite, error } = await getInviteByToken(token)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Server-side check: does this email already have a Settle account?
  // Done server-side to avoid exposing user existence to the public via client calls.
  let emailExists = false
  if (invite && !user) {
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    emailExists = existingUsers?.users?.some(
      (u) => u.email?.toLowerCase() === invite.email.toLowerCase()
    ) ?? false
  }

  if (error || !invite) {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Invalid Invite</h2>
          <p className="text-sm text-gray-500">This invite link is invalid, expired, or has already been used.</p>
          <a href="/login" className="inline-block mt-6 text-sm font-medium text-blue-600 hover:text-blue-700">
            Go to login &rarr;
          </a>
        </div>
      </Shell>
    )
  }

  if (invite.accepted_at) {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Already Accepted</h2>
          <p className="text-sm text-gray-500">This invite has already been accepted.</p>
          <a href="/login" className="inline-block mt-6 text-sm font-medium text-blue-600 hover:text-blue-700">
            Sign in &rarr;
          </a>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <Suspense fallback={<div className="h-40 flex items-center justify-center"><div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>}>
        <InviteClient
          token={token}
          orgName={invite.org_name ?? 'Team'}
          role={invite.role}
          inviterName={invite.inviter_name ?? 'A team member'}
          email={invite.email}
          isLoggedIn={!!user}
          userId={user?.id}
          emailExists={emailExists}
        />
      </Suspense>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <a href="/">
            <img src="/images/logos/settle-logo-full.svg" alt="Settle" className="h-8 w-auto" />
          </a>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          {children}
        </div>
      </div>
    </div>
  )
}
