'use client'

// ─────────────────────────────────────────────────────────────────────
// LegacyLoginForm — pre-B-2-b /login implementation, preserved verbatim
// ─────────────────────────────────────────────────────────────────────
//
// Purpose: feature-flag fallback. When
// `process.env.NEXT_PUBLIC_LOGIN_EMAIL_FIRST === 'false'` the login
// shell renders this instead of `EmailFirstLoginForm`, restoring
// behavior exactly as it was before commit B-2-b shipped.
//
// PRESERVE BUGS: This is an EXTRACTION, not a refactor. The three
// pre-existing bugs the investigation report identified
//   1. ?returnTo= is silently ignored (only ?redirect= is read)
//   2. safeRedirect lets //evil.com through (only startsWith('/'))
//   3. The catch block leaves loading=true on unexpected errors
// are deliberately retained here so a flag flip during incident
// response gives 100%-predictable rollback. EmailFirstLoginForm fixes
// all three.
//
// Also preserves the single-stage email+password layout, the
// `?reason=timeout`-only banner, and the inline `<Alert>` for
// per-attempt errors. Imports and copy are unchanged from the
// original `app/login/page.tsx` LoginContent component.
//
// To remove (after 14 days of EmailFirst stability in prod): delete
// this file, delete the env-var branch in app/login/page.tsx, drop
// `NEXT_PUBLIC_LOGIN_EMAIL_FIRST` from Vercel.

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

export default function LegacyLoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reason = searchParams.get('reason')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const supabase = createClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (signInError) {
        // Security: Don't reveal if email exists
        if (signInError.message.includes('Invalid login credentials')) {
          setError('Invalid email or password. Please try again.')
        } else if (signInError.message.includes('Email not confirmed')) {
          setError('Please verify your email address before signing in. Check your inbox for the verification link.')
        } else {
          setError('An error occurred. Please try again.')
        }
        setLoading(false)
        return
      }

      // Redirect to the original destination or /app/projects.
      // Validate starts with / to prevent open-redirect attacks.
      const rawRedirect = searchParams.get('redirect')
      const safeRedirect = rawRedirect?.startsWith('/') ? rawRedirect : '/app/projects'
      router.push(safeRedirect)
      router.refresh()
    } catch (err) {
      // PRESERVED BUG: this catch block does not call setLoading(false).
      // EmailFirstLoginForm fixes this; do not fix it here — the
      // legacy form is meant to be byte-identical to the pre-B-2-b
      // behavior so a flag flip is a true rollback.
      setError('An unexpected error occurred. Please try again.')
    }
  }

  return (
    <AuthCard
      title="Sign in to Settle"
      subtitle="Access your data migration projects"
      footer={{
        text: "Don't have an account?",
        linkText: 'Request access',
        linkHref: '/request-access',
      }}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {reason === 'timeout' && (
          <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
            Your session has expired due to inactivity. Please sign in again.
          </div>
        )}
        {error && (
          <Alert variant="destructive" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <FormField
          label="Work email"
          name="email"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />

        <div className="space-y-2">
          <FormField
            label="Password"
            name="password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        <Button type="submit" variant="default" size="lg" className="w-full" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  )
}
