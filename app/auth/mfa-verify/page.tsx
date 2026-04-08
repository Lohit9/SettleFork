'use client'

import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { ShieldCheck, Loader2 } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

function MFAChallengeContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirect') || '/app/projects'

  const supabase = createClient()
  const [factorId, setFactorId] = useState<string | null>(null)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const codeInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const init = async () => {
      // Get the TOTP factor and start a challenge immediately
      const { data: factors, error: factorsErr } = await supabase.auth.mfa.listFactors()
      if (factorsErr || !factors?.totp?.length) {
        // No MFA factor — shouldn't be here, redirect to app
        router.replace('/app/projects')
        return
      }
      const factor = factors.totp.find((f) => f.status === 'verified') ?? factors.totp[0]
      setFactorId(factor.id)

      const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      })
      if (challengeErr || !challenge) {
        setError('Could not initiate MFA challenge. Please refresh and try again.')
        setInitializing(false)
        return
      }
      setChallengeId(challenge.id)
      setInitializing(false)
      setTimeout(() => codeInputRef.current?.focus(), 50)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleVerify = async () => {
    if (!factorId || !challengeId || code.length !== 6) return
    setError(null)
    setLoading(true)

    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId,
      code,
    })

    if (verifyErr) {
      // If challenge expired, start a new one
      if (verifyErr.message?.toLowerCase().includes('expired')) {
        const { data: newChallenge } = await supabase.auth.mfa.challenge({ factorId })
        if (newChallenge) setChallengeId(newChallenge.id)
      }
      setError('Invalid code. Please try again.')
      setCode('')
      setLoading(false)
      setTimeout(() => codeInputRef.current?.focus(), 50)
      return
    }

    // Session is now aal2 — navigate to destination
    router.push(redirectTo)
    router.refresh()
  }

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    setError(null)
  }

  const handleCodePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    setError(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && code.length === 6) {
      handleVerify()
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 flex justify-center">
          <Link href="/">
            <img
              src="/images/logos/settle-logo-full.svg"
              alt="Settle"
              className="h-8 w-auto"
            />
          </Link>
        </div>

        {/* Card */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
          <div className="px-8 pt-8 pb-6">
            {/* Icon + heading */}
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mb-4">
                <ShieldCheck className="w-6 h-6 text-blue-600" />
              </div>
              <h1 className="text-xl font-bold text-gray-900">Two-factor authentication</h1>
              <p className="text-sm text-gray-500 mt-1.5">
                Enter the 6-digit code from your authenticator app
              </p>
            </div>

            {initializing ? (
              <div className="flex justify-center py-6">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : (
              <>
                {/* Code input */}
                <div className="mb-4">
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={handleCodeChange}
                    onPaste={handleCodePaste}
                    onKeyDown={handleKeyDown}
                    placeholder="000000"
                    disabled={loading}
                    className="w-full text-center text-3xl font-mono tracking-[0.6em] border border-gray-200 rounded-lg px-4 py-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-300 placeholder:tracking-normal disabled:opacity-50"
                  />
                  {error && (
                    <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 text-center">
                      {error}
                    </div>
                  )}
                </div>

                {/* Verify button */}
                <Button
                  onClick={handleVerify}
                  disabled={code.length !== 6 || loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                  size="lg"
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Verifying…
                    </span>
                  ) : (
                    'Verify'
                  )}
                </Button>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-8 py-4 text-center">
            <button
              onClick={handleSignOut}
              className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2"
            >
              Use a different account
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function MFAVerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <MFAChallengeContent />
    </Suspense>
  )
}
