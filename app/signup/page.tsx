'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { signUpWithBotProtection } from '@/lib/actions/auth'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'

const PERSONAL_EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com']

export default function SignupPage() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [formData, setFormData] = useState({
    fullName: '',
    companyName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companySize: '',
    role: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [emailWarning, setEmailWarning] = useState(false)

  // Bot protection: record when the page loaded (used for minimum-time check)
  const loadedAtRef = useRef<number>(0)
  useEffect(() => {
    loadedAtRef.current = Date.now()
  }, [])

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setFormData((prev) => ({ ...prev, email: value }))
    if (value.includes('@')) {
      const domain = value.split('@')[1]?.toLowerCase() ?? ''
      setEmailWarning(PERSONAL_EMAIL_DOMAINS.includes(domain))
    } else {
      setEmailWarning(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    // Client-side field validation
    if (!formData.fullName || !formData.companyName || !formData.email || !formData.password) {
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

    // Client-side honeypot check (defence-in-depth; server also checks)
    const form = e.currentTarget
    const honeypotEl = form.elements.namedItem('website') as HTMLInputElement | null
    if (honeypotEl?.value) {
      // Silent fake-success — don't reveal that we noticed
      setSuccess(true)
      return
    }

    startTransition(async () => {
      const result = await signUpWithBotProtection({
        fullName: formData.fullName,
        companyName: formData.companyName,
        email: formData.email,
        password: formData.password,
        companySize: formData.companySize,
        role: formData.role,
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
        <Button
          variant="default"
          size="lg"
          className="w-full"
          onClick={() => router.push('/login')}
        >
          Go to Sign In
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Get started with Mine"
      subtitle="Create your account in minutes"
      footer={{
        text: 'Already have an account?',
        linkText: 'Sign in',
        linkHref: '/login',
      }}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {emailWarning && (
          <Alert variant="default">
            Please use your work email address. Personal email domains are not recommended for business accounts.
          </Alert>
        )}

        {/*
          Bot protection — honeypot field.
          Hidden from real users via CSS. Bots auto-fill every input.
          aria-hidden prevents screen readers from reading it.
          tabIndex={-1} prevents keyboard navigation to it.
        */}
        <div aria-hidden="true" style={{ display: 'none' }}>
          <label htmlFor="website">Website</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        <FormField
          label="Full name"
          name="fullName"
          placeholder="John Doe"
          value={formData.fullName}
          onChange={(e) => setFormData((prev) => ({ ...prev, fullName: e.target.value }))}
          required
          autoComplete="name"
        />

        <FormField
          label="Company name"
          name="companyName"
          placeholder="Acme Inc."
          value={formData.companyName}
          onChange={(e) => setFormData((prev) => ({ ...prev, companyName: e.target.value }))}
          required
          autoComplete="organization"
        />

        <div className="space-y-2">
          <FormField
            label="Work email"
            name="email"
            type="email"
            placeholder="you@company.com"
            value={formData.email}
            onChange={handleEmailChange}
            required
            autoComplete="email"
          />
        </div>

        <FormField
          label="Password"
          name="password"
          type="password"
          placeholder="At least 8 characters"
          value={formData.password}
          onChange={(e) => setFormData((prev) => ({ ...prev, password: e.target.value }))}
          required
          autoComplete="new-password"
        />

        <FormField
          label="Confirm password"
          name="confirmPassword"
          type="password"
          placeholder="Confirm your password"
          value={formData.confirmPassword}
          onChange={(e) => setFormData((prev) => ({ ...prev, confirmPassword: e.target.value }))}
          required
          autoComplete="new-password"
        />

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="companySize">Company size (optional)</Label>
            <select
              id="companySize"
              name="companySize"
              value={formData.companySize}
              onChange={(e) => setFormData((prev) => ({ ...prev, companySize: e.target.value }))}
              className="flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              <option value="">Select size</option>
              <option value="1-10">1-10</option>
              <option value="11-50">11-50</option>
              <option value="51-200">51-200</option>
              <option value="200+">200+</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Role (optional)</Label>
            <select
              id="role"
              name="role"
              value={formData.role}
              onChange={(e) => setFormData((prev) => ({ ...prev, role: e.target.value }))}
              className="flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              <option value="">Select role</option>
              <option value="data">Data</option>
              <option value="engineering">Engineering</option>
              <option value="it">IT</option>
              <option value="finance">Finance</option>
              <option value="operations">Operations</option>
            </select>
          </div>
        </div>

        <Button type="submit" variant="default" size="lg" className="w-full" disabled={isPending}>
          {isPending ? 'Creating account...' : 'Get started for free'}
        </Button>

        <p className="text-center text-xs text-gray-500">No credit card required</p>
      </form>
    </AuthCard>
  )
}
