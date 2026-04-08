'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import AuthCard from '@/components/auth/AuthCard'
import FormField from '@/components/auth/FormField'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [origin, setOrigin] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const supabase = createClient()
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.usesettle.ai'}/api/auth/callback?type=recovery`,
      })

      if (resetError) {
        // Security: Don't reveal if email exists
        setError('If an account exists with this email, you will receive a password reset link.')
        setLoading(false)
        // Still show success to prevent enumeration
        setSuccess(true)
        return
      }

      setSuccess(true)
      setLoading(false)
    } catch (err) {
      // Security: Always show success to prevent enumeration
      setSuccess(true)
      setLoading(false)
    }
  }

  if (success) {
    return (
      <AuthCard title="Check your email" subtitle="We've sent you a password reset link">
        <Alert variant="success">
          If an account exists with {email}, you will receive a password reset link shortly.
        </Alert>
        <Button
          variant="default"
          size="lg"
          className="w-full"
          onClick={() => router.push('/login')}
        >
          Back to Sign In
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your email address and we'll send you a reset link"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
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

        <Button type="submit" variant="default" size="lg" className="w-full" disabled={loading}>
          {loading ? 'Sending...' : 'Send reset link'}
        </Button>
      </form>
    </AuthCard>
  )
}
