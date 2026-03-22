'use client'

import { Suspense, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { signUpWithBotProtection } from '@/lib/actions/auth'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

function SignupContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const [formData, setFormData] = useState({
    inviteCode: '',
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Bot protection: record when the page loaded
  const loadedAtRef = useRef<number>(0)
  useEffect(() => {
    loadedAtRef.current = Date.now()
  }, [])

  // Pre-fill invite code from ?invite= URL param
  useEffect(() => {
    const invite = searchParams.get('invite')
    if (invite) {
      setFormData((prev) => ({ ...prev, inviteCode: invite.toUpperCase() }))
    }
  }, [searchParams])

  const set = (field: keyof typeof formData) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setFormData((prev) => ({ ...prev, [field]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    if (!formData.inviteCode.trim()) {
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

    // Client-side honeypot check
    const form = e.currentTarget
    const honeypotEl = form.elements.namedItem('website') as HTMLInputElement | null
    if (honeypotEl?.value) {
      setSuccess(true)
      return
    }

    startTransition(async () => {
      const result = await signUpWithBotProtection({
        inviteCode: formData.inviteCode.trim().toUpperCase(),
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
      subtitle="You'll need an invite code to get started"
      footer={{
        text: 'Already have an account?',
        linkText: 'Sign in',
        linkHref: '/login',
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

        {/* Honeypot — hidden from real users */}
        <div aria-hidden="true" style={{ display: 'none' }}>
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>

        {/* Invite code */}
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
          {!searchParams.get('invite') && (
            <p className="text-xs text-gray-500">
              Don&apos;t have an invite code?{' '}
              <Link href="/request-access" className="text-blue-600 hover:text-blue-700 font-medium">
                Request access
              </Link>
            </p>
          )}
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
          {isPending ? 'Creating account…' : 'Create account'}
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
