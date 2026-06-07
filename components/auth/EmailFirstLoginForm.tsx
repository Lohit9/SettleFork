'use client'

// ─────────────────────────────────────────────────────────────────────
// EmailFirstLoginForm — B-2-b deliverable
// ─────────────────────────────────────────────────────────────────────
//
// Two-stage login flow with SSO discovery:
//
//   Stage 1 (email): user enters email + clicks Continue.
//                    - Local email regex validation (don't burn the
//                      rate-limit on bad input).
//                    - Calls checkSSOEnabledForEmail (server action,
//                      rate-limited per B-2-a-i).
//                    - Strict SSO  → window.location → /sso/start
//                    - Hybrid SSO  → advance to Stage 2 with SSO
//                                    button visible alongside password
//                    - No SSO      → advance to Stage 2 password-only
//
//   Stage 2 (password): user enters password + clicks Sign in.
//                    - signInWithPassword from the browser (matches
//                      the existing flow pattern; Supabase SSR adapter
//                      writes session cookies).
//                    - Edit affordance returns to Stage 1 and CLEARS
//                      the password (security: never carry a password
//                      across an email change).
//                    - Hybrid mode shows a "Continue with single
//                      sign-on" button in addition to the password
//                      form; clicking it does the same redirect as
//                      the strict-SSO branch above.
//
// Bug fixes vs. the legacy form (Mini-D4):
//   - Reads BOTH ?redirect= and ?returnTo= via the new safe-next helper.
//   - Blocks //evil.com (and CRLF) via the same helper.
//   - Every error path explicitly resets `loading` (the legacy catch
//     block left it stuck on true, locking the form).
//
// Reason-code rendering: every code emitted on /login redirects gets
// proper UI via the LOGIN_REASONS map. The banner appears on Stage 1
// only and is dismissed implicitly when the user transitions to Stage
// 2 (the reason was about why-we-landed-here, stale once the user
// starts acting).
//
// Browser-autofill compatibility (Mini-D2): a hidden
// <input type="password"> is rendered on Stage 1 alongside the email
// field. Password managers detect both fields by `type=password`
// regardless of visibility; the same `password` state holds the
// autofilled value when the user advances to Stage 2.

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { checkSSOEnabledForEmail } from '@/lib/actions/sso'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { getSafeNext } from '@/lib/auth/safe-next'
import { getReasonCopy } from '@/lib/auth/login-reason-codes'

// Mirrors the server-side regex at lib/actions/sso.ts:68. Kept in
// sync deliberately — the client gate prevents wasted server probes
// for obviously-invalid input, but the server is the source of truth
// (anyone can disable JS).
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

type Stage = 'email' | 'password'

/**
 * Build the SSO redirect URL for a given org slug, preserving the
 * caller-supplied next destination.
 *
 * Not exported — used only inside this component. The full-page
 * navigation is intentional (window.location, NOT router.push)
 * because /sso/start needs to Set-Cookie on a top-level GET response;
 * a client-side router transition would lose the PKCE-verifier cookie.
 */
function buildSsoStartUrl(
  orgSlug: string,
  searchParams: { get(key: string): string | null },
): string {
  const safeNext = getSafeNext(searchParams)
  return `/sso/start?org=${encodeURIComponent(orgSlug)}&next=${encodeURIComponent(safeNext)}`
}

export default function EmailFirstLoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [stage, setStage] = useState<Stage>('email')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Set when Stage 1 detects a provider for the email's domain.
  // - Strict mode  → handleEmailContinue redirects, this never gets set.
  // - Hybrid mode  → set so Stage 2 renders the SSO button.
  // - No SSO       → stays null on Stage 2.
  const [orgSlug, setOrgSlug] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefer ?reason= over ?error= when both are present. Today only
  // `auth_callback_error` uses the `error` channel; the rest use
  // `reason`. The single-channel banner avoids stacking two reasons
  // for the same redirect.
  const reasonFromUrl =
    searchParams.get('reason') ?? searchParams.get('error')
  const reasonCopy = getReasonCopy(reasonFromUrl)
  // Banner is dismissed once the user advances to Stage 2 — at that
  // point they've moved past the why-am-I-here moment that the
  // reason code was answering, and a stale banner alongside a fresh
  // form state would be confusing.
  const showReasonBanner = stage === 'email' && reasonCopy !== null

  // Focus management on stage transitions. We don't widen FormField's
  // API to accept refs — instead we look up the rendered input by id
  // (FormField sets `id={name}`). The setTimeout(50) defers focus to
  // the next tick so the conditionally-rendered input is mounted by
  // the time we try to focus it. This mirrors the pattern in
  // app/auth/mfa-verify/page.tsx:48.
  useEffect(() => {
    const id = stage === 'password' ? 'password' : 'email'
    const handle = setTimeout(() => {
      const el =
        typeof document !== 'undefined'
          ? (document.getElementById(id) as HTMLInputElement | null)
          : null
      el?.focus()
    }, 50)
    return () => clearTimeout(handle)
  }, [stage])

  async function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!email || !EMAIL_REGEX.test(email)) {
      setError('Enter a valid email address.')
      return
    }

    setLoading(true)

    let result: { required: boolean; orgSlug?: string } = { required: false }
    try {
      result = (await checkSSOEnabledForEmail(email)) ?? { required: false }
    } catch (probeErr) {
      // Fail-soft: a thrown probe (network blip, Vercel function
      // timeout) must NOT block login. Strict-SSO orgs are still
      // protected: middleware enforcement signs out password-backed
      // sessions on the next /app/* request and bounces with
      // ?reason=sso_required. So fall through to password Stage 2 —
      // the worst case is one extra round trip for a strict user.
      console.warn(
        '[login] checkSSOEnabledForEmail threw; falling through to password',
        probeErr,
      )
      result = { required: false }
    }

    if (result.required && result.orgSlug) {
      // Strict SSO: full-page navigation so /sso/start can
      // Set-Cookie on its response (PKCE verifier).
      window.location.href = buildSsoStartUrl(result.orgSlug, searchParams)
      // Don't reset loading — the page is leaving.
      return
    }

    setLoading(false)
    setOrgSlug(result.orgSlug ?? null)
    setStage('password')
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
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
        // Match the legacy error mapping verbatim — these strings
        // have been in the product since auth went live.
        if (signInError.message.includes('Invalid login credentials')) {
          setError('Invalid email or password. Please try again.')
        } else if (signInError.message.includes('Email not confirmed')) {
          setError(
            'Please verify your email address before signing in. Check your inbox for the verification link.',
          )
        } else {
          setError('An error occurred. Please try again.')
        }
        setLoading(false)
        return
      }

      router.push(getSafeNext(searchParams))
      router.refresh()
    } catch (err) {
      // Bug 3 fix (Mini-D4): the legacy form left loading=true here,
      // locking the form on transient network errors.
      console.error('[login] sign-in threw:', err)
      setError('An unexpected error occurred. Please try again.')
      setLoading(false)
    }
  }

  function handleSsoButtonClick() {
    if (!orgSlug || loading) return
    window.location.href = buildSsoStartUrl(orgSlug, searchParams)
  }

  function handleEditEmail() {
    if (loading) return
    // SECURITY: when the user edits the email, drop the password.
    // Otherwise a "wrong account" correction would attempt the new
    // email's login with the previous account's credential.
    setStage('email')
    setPassword('')
    setOrgSlug(null)
    setError(null)
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
      {showReasonBanner && reasonCopy ? (
        <Alert
          variant={reasonCopy.severity === 'error' ? 'destructive' : 'default'}
          // Inline role for screen-reader announcement on destructive
          // banners. The Alert primitive doesn't set role itself; this
          // is the least-invasive way to add it. Info banners use the
          // default (no role) since they're not interruption-worthy.
          role={reasonCopy.severity === 'error' ? 'alert' : undefined}
          data-testid="reason-banner"
        >
          {reasonCopy.copy}
        </Alert>
      ) : null}

      {error ? (
        <Alert
          variant="destructive"
          role="alert"
          onClose={() => setError(null)}
          data-testid="form-error"
        >
          {error}
        </Alert>
      ) : null}

      {stage === 'email' ? (
        <form
          onSubmit={handleEmailContinue}
          className="space-y-4"
          data-testid="email-stage-form"
        >
          <FormField
            label="Work email"
            name="email"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            disabled={loading}
          />

          {/*
            Hidden password field for autofill (Mini-D2). Password
            managers identify the credential pair by the email + a
            password-typed input; rendering this on Stage 1 lets them
            fill both fields in one motion, and the same React state
            survives the stage transition.

            sr-only hides it visually; tabIndex={-1} keeps it out of
            the keyboard tab order; aria-hidden tells screen readers
            to skip it (the visible Stage 2 password input is the one
            screen-reader users interact with). Setting `name="password"`
            is required for autofill targeting; this never collides
            with the Stage 2 visible input because the two are
            conditionally rendered, never both in the DOM.
          */}
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            data-testid="hidden-password-autofill"
          />

          <Button
            type="submit"
            variant="default"
            size="lg"
            className="w-full"
            disabled={loading}
            data-testid="continue-button"
          >
            {loading ? 'Checking…' : 'Continue'}
          </Button>
        </form>
      ) : (
        <form
          onSubmit={handlePasswordSubmit}
          className="space-y-4"
          data-testid="password-stage-form"
        >
          <div
            className="flex items-center justify-between rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-sm"
            data-testid="email-readonly"
          >
            <span className="text-gray-700 truncate" title={email}>
              Signing in as <strong>{email}</strong>
            </span>
            <button
              type="button"
              onClick={handleEditEmail}
              className="text-blue-600 hover:text-blue-700 ml-2 shrink-0 disabled:opacity-50"
              disabled={loading}
              data-testid="edit-email-button"
            >
              Edit
            </button>
          </div>

          {orgSlug ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                onClick={handleSsoButtonClick}
                disabled={loading}
                data-testid="sso-button"
              >
                Continue with single sign-on
              </Button>
              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-2 text-gray-500">
                    or sign in with password
                  </span>
                </div>
              </div>
            </>
          ) : null}

          <FormField
            label="Password"
            name="password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            disabled={loading}
          />

          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              Forgot password?
            </Link>
          </div>

          <Button
            type="submit"
            variant="default"
            size="lg"
            className="w-full"
            disabled={loading}
            data-testid="signin-button"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}
    </AuthCard>
  )
}
