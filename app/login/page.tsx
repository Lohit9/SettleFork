'use client'

import { Suspense } from 'react'
import EmailFirstLoginForm from '@/components/auth/EmailFirstLoginForm'
import LegacyLoginForm from '@/components/auth/LegacyLoginForm'
import AuthCard from '@/components/auth/AuthCard'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────
// Feature flag — Mini-D3
// ─────────────────────────────────────────────────────────────────────
//
// `NEXT_PUBLIC_LOGIN_EMAIL_FIRST` is read at module load (i.e. build
// time for the static portion of this client bundle). Setting it to
// the literal string `'false'` selects the LegacyLoginForm; any other
// value (including unset) selects the new EmailFirstLoginForm.
//
// This is intentionally a deploy-time switch, NOT a runtime toggle.
// Rollback procedure if EmailFirst breaks production:
//   1. Set NEXT_PUBLIC_LOGIN_EMAIL_FIRST=false in Vercel (Production
//      and Preview scopes).
//   2. Redeploy (or trigger a rebuild). The legacy form starts
//      rendering immediately.
//
// To turn the new flow back on: unset the var (or set to 'true') and
// redeploy.
//
// Removal plan: after 14 days of EmailFirst stability, delete the
// flag, the legacy import, and `components/auth/LegacyLoginForm.tsx`.
// Tracked in docs/outstanding-items.md.
const isEmailFirstEnabled =
  process.env.NEXT_PUBLIC_LOGIN_EMAIL_FIRST !== 'false'

function LoginContent() {
  return isEmailFirstEnabled ? <EmailFirstLoginForm /> : <LegacyLoginForm />
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Sign in to Settle" subtitle="Loading...">
          <div className="text-center">
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent mx-auto"></div>
          </div>
        </AuthCard>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
