'use client'

import { Suspense, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { signUpWithBotProtection } from '@/lib/actions/auth'
import { getInviteByToken } from '@/lib/actions/org-invites'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

function SignupContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const orgToken = searchParams.get('token')
  const legacyInvite = searchParams.get('invite')

  const [formData, setFormData] = useState({
    inviteCode: '',
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [orgInviteInfo, setOrgInviteInfo] = useState<{ orgName: string; role: string; email: string } | null>(null)

  const loadedAtRef = useRef<number>(0)
  useEffect(() => {
    loadedAtRef.current = Date.now()
  }, [])

  // Org invite token: fetch invite details
  useEffect(() => {
    if (orgToken) {
      getInviteByToken(orgToken).then(({ invite }) => {
        if (invite) {
          setOrgInviteInfo({ orgName: invite.org_name || 'the organization', role: invite.role, email: invite.email })
          setFormData((prev) => ({ ...prev, email: invite.email }))
        }
      })
    }
  }, [orgToken])

  // Legacy invite code: pre-fill from ?invite= param
  useEffect(() => {
    if (!orgToken && legacyInvite) {
      setFormData((prev) => ({ ...prev, inviteCode: legacyInvite.toUpperCase() }))
    }
  }, [orgToken, legacyInvite])

  // No token and no invite code → redirect to request access
  useEffect(() => {
    if (!orgToken && !legacyInvite) {
      router.replace('/request-access')
    }
  }, [orgToken, legacyInvite, router])

  const set = (field: keyof typeof formData) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setFormData((prev) => ({ ...prev, [field]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    const isOrgFlow = !!orgToken
    if (!isOrgFlow && !formData.inviteCode.trim()) {
      setError('An invite code is required to sign up.')
      return
    }
    if (!formData.fullName || !formData.email || !formData.password) {
      setError('Please fill in all required fields.')
      return
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters long.')
      return
    }

    const form = e.currentTarget
    const honeypotEl = form.elements.namedItem('website') as HTMLInputElement | null
    if (honeypotEl?.value) {
      setSuccess(true)
      return
    }

    startTransition(async () => {
      const result = await signUpWithBotProtection({
        ...(isOrgFlow
          ? { inviteToken: orgToken!, inviteCode: '' }
          : { inviteCode: formData.inviteCode.trim().toUpperCase() }),
        fullName: formData.fullName,
        email: formData.email,
        password: formData.password,
        website: honeypotEl?.value ?? '',
        loadedAt: String(loadedAtRef.current),
      })

      if (!result.success) {
        setError(result.error ?? 'Unable to create account. Please try again.')
        return
      }

      if (result.requiresEmailVerification) {
        setSuccess(true)
      } else {
        router.push('/app/projects')
        router.refresh()
      }
    })
  }

  if (success) {
    return (
      <AuthCard title="Check your email" subtitle="We've sent you a confirmation link">
        <Alert variant="success">
          Please check your email ({formData.email}) to confirm your account before signing in.
        </Alert>
        <Button variant="default" size="lg" className="w-full" onClick={() => router.push('/login')}>
          Go to Sign In
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle={orgInviteInfo
        ? `Join ${orgInviteInfo.orgName} as ${orgInviteInfo.role}`
        : "You'll need an invite code to get started"}
      footer={{
        text: 'Already have an account?',
        linkText: 'Sign in',
        linkHref: orgToken ? `/login?redirect=/invite/${orgToken}` : '/login',
      }}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive" onClose={() => setError(null)}>
            {error.includes('request-access') || error.includes('trymine.ai/request') ? (
              <>
                {error.split('trymine.ai/request-access')[0]}
                <Link href="/request-access" className="underline font-medium">
                  request early access
                </Link>
              </>
            ) : (
              error
            )}
          </Alert>
        )}

        {orgInviteInfo && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
            <p className="text-sm text-blue-800">
              You&apos;ve been invited to join <span className="font-semibold">{orgInviteInfo.orgName}</span> as a <span className="font-semibold capitalize">{orgInviteInfo.role}</span>.
            </p>
          </div>
        )}

        {/* Honeypot — hidden from real users */}
        <div aria-hidden="true" style={{ display: 'none' }}>
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>

        {/* Legacy invite code — only shown when no org token */}
        {!orgToken && (
          <div className="space-y-1.5">
            <FormField
              label="Invite code"
              name="inviteCode"
              placeholder="MINE-XXXXXX"
              value={formData.inviteCode}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  inviteCode: e.target.value.toUpperCase(),
                }))
              }
              required
              autoComplete="off"
            />
            {!legacyInvite && (
              <p className="text-xs text-gray-500">
                Don&apos;t have an invite code?{' '}
                <Link href="/request-access" className="text-blue-600 hover:text-blue-700 font-medium">
                  Request access
                </Link>
              </p>
            )}
          </div>
        )}

        <FormField
          label="Full name"
          name="fullName"
          placeholder="Jane Smith"
          value={formData.fullName}
          onChange={set('fullName')}
          required
          autoComplete="name"
        />

        <FormField
          label="Work email"
          name="email"
          type="email"
          placeholder="you@company.com"
          value={formData.email}
          onChange={set('email')}
          required
          autoComplete="email"
          disabled={!!orgInviteInfo}
        />

        <FormField
          label="Password"
          name="password"
          type="password"
          placeholder="At least 8 characters"
          value={formData.password}
          onChange={set('password')}
          required
          autoComplete="new-password"
        />

        <FormField
          label="Confirm password"
          name="confirmPassword"
          type="password"
          placeholder="Confirm your password"
          value={formData.confirmPassword}
          onChange={set('confirmPassword')}
          required
          autoComplete="new-password"
        />

        <Button type="submit" variant="default" size="lg" className="w-full" disabled={isPending}>
          {isPending
            ? 'Creating account…'
            : orgToken
              ? 'Create Account & Join'
              : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  )
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Create your account" subtitle="Loading…">
          <div className="flex justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          </div>
        </AuthCard>
      }
    >
      <SignupContent />
    </Suspense>
  )
}
