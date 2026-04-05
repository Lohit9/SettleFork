'use client'

import { Suspense, useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { resendVerificationEmail, signOut } from '@/lib/actions/auth'
import AuthCard from '@/components/auth/AuthCard'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'

export const dynamic = 'force-dynamic'

function VerifyEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const verified = searchParams.get('verified') === 'true'

  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [resendState, setResendState] = useState<'idle' | 'sent' | 'error'>('idle')
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const check = async () => {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      setUserEmail(user?.email ?? null)
      setLoading(false)
    }
    check()
  }, [])

  const handleResend = () => {
    startTransition(async () => {
      const result = await resendVerificationEmail()
      setResendState(result.success ? 'sent' : 'error')
    })
  }

  const handleSignOut = () => {
    startTransition(async () => {
      await signOut()
      router.push('/login')
      router.refresh()
    })
  }

  if (loading) {
    return (
      <AuthCard title="Verify Your Email" subtitle="Please wait...">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent mx-auto" />
        </div>
      </AuthCard>
    )
  }

  if (verified) {
    return (
      <AuthCard title="Email Verified" subtitle="Your email has been successfully verified">
        <Alert variant="success">Your email is confirmed — you can now access your account.</Alert>
        <Button
          variant="default"
          size="lg"
          className="w-full"
          onClick={() => router.push('/app/projects')}
        >
          Go to Dashboard
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Almost there!"
      subtitle="Check your inbox to activate your account"
    >
      <Alert variant="default">
        We sent a verification link to <strong>{userEmail ?? 'your email address'}</strong>.
        Click the link in that email to activate your account.
      </Alert>

      {resendState === 'sent' && (
        <Alert variant="success">
          Verification email resent — check your inbox and spam folder.
        </Alert>
      )}
      {resendState === 'error' && (
        <Alert variant="destructive">
          Unable to resend the email. Please try again in a moment.
        </Alert>
      )}

      <Button
        variant="default"
        size="lg"
        className="w-full"
        onClick={handleResend}
        disabled={isPending || resendState === 'sent'}
      >
        {isPending ? 'Sending...' : resendState === 'sent' ? 'Email sent ✓' : 'Resend Verification Email'}
      </Button>

      <p className="text-center text-xs text-gray-500">
        Didn&apos;t receive it? Check your spam folder or try resending.
      </p>

      <p className="text-center text-xs text-gray-500">
        Wrong account?{' '}
        <button
          className="text-blue-600 hover:underline"
          onClick={handleSignOut}
          disabled={isPending}
        >
          Sign out
        </button>
        {' · '}
        <button
          className="text-blue-600 hover:underline"
          onClick={() => router.push('/login')}
        >
          Sign in
        </button>
      </p>
    </AuthCard>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Verify Your Email" subtitle="Please wait...">
          <div className="text-center">
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent mx-auto" />
          </div>
        </AuthCard>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  )
}
