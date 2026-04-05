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

  const [formData, setFormData] = useState({
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

  // No org invite token → redirect to request access
  useEffect(() => {
    if (!orgToken) {
      router.replace('/request-access')
    }
  }, [orgToken, router])

  // Org invite token: fetch invite details and pre-fill email
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

  const set = (field: keyof typeof formData) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setFormData((prev) => ({ ...prev, [field]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

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
        inviteToken: orgToken!,
        inviteCode: '',
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
        router.push('/verify-email')
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

  // While redirecting (no token case) show nothing meaningful
  if (!orgToken) return null

  return (
    <AuthCard
      title="Create your account"
      subtitle={orgInviteInfo
        ? `Join ${orgInviteInfo.orgName} as ${orgInviteInfo.role}`
        : 'Accept your invite and create an account'}
      footer={{
        text: 'Already have an account?',
        linkText: 'Sign in',
        linkHref: `/login?redirect=/invite/${orgToken}`,
      }}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {orgInviteInfo && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
            <p className="text-sm text-blue-800">
              You&apos;ve been invited to join{' '}
              <span className="font-semibold">{orgInviteInfo.orgName}</span> as a{' '}
              <span className="font-semibold capitalize">{orgInviteInfo.role}</span>.
            </p>
          </div>
        )}

        {/* Honeypot — hidden from real users */}
        <div aria-hidden="true" style={{ display: 'none' }}>
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>

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
          {isPending ? 'Creating account…' : 'Create Account & Join'}
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
