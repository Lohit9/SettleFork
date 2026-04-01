'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Shield, ShieldCheck, Smartphone, Copy, Check, Loader2 } from 'lucide-react'

type MFAState = 'loading' | 'idle' | 'setup' | 'enrolled'

interface EnrolledFactor {
  id: string
  friendly_name?: string
  created_at: string
}

interface EnrollData {
  factorId: string
  qrCode: string
  secret: string
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
      {message}
    </div>
  )
}

function ConfirmDisableModal({
  onConfirm,
  onCancel,
  loading,
}: {
  onConfirm: () => void
  onCancel: () => void
  loading: boolean
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <Shield className="w-4.5 h-4.5 text-red-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Disable two-factor authentication?</h2>
        </div>
        <p className="text-sm text-gray-600 mb-5">
          This will remove two-factor authentication from your account. Your account will be less
          secure without it.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={loading} className="text-gray-600">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={loading}
            className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Disabling…
              </span>
            ) : (
              'Disable 2FA'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function MFAEnrollment() {
  const supabase = createClient()
  const [state, setState] = useState<MFAState>('loading')
  const [enrolledFactor, setEnrolledFactor] = useState<EnrolledFactor | null>(null)
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const [isPending, startTransition] = useTransition()
  const codeInputRef = useRef<HTMLInputElement>(null)

  // Load initial MFA state
  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error || !data) {
        setState('idle')
        return
      }
      const verified = data.totp?.find((f) => f.status === 'verified')
      if (verified) {
        setEnrolledFactor({ id: verified.id, friendly_name: verified.friendly_name, created_at: verified.created_at })
        setState('enrolled')
      } else {
        setState('idle')
      }
    }
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus code input when entering setup state
  useEffect(() => {
    if (state === 'setup') {
      setTimeout(() => codeInputRef.current?.focus(), 50)
    }
  }, [state])

  const handleEnable = () => {
    setError(null)
    startTransition(async () => {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
      if (error || !data) {
        setError(error?.message ?? 'Failed to start enrollment. Please try again.')
        return
      }
      setEnrollData({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      })
      setCode('')
      setState('setup')
    })
  }

  const handleVerify = () => {
    if (!enrollData || code.length !== 6) return
    setError(null)
    startTransition(async () => {
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId: enrollData.factorId,
      })
      if (challengeErr || !challengeData) {
        setError(challengeErr?.message ?? 'Challenge failed. Please try again.')
        setCode('')
        codeInputRef.current?.focus()
        return
      }
      const { data: verifyData, error: verifyErr } = await supabase.auth.mfa.verify({
        factorId: enrollData.factorId,
        challengeId: challengeData.id,
        code,
      })
      if (verifyErr || !verifyData) {
        setError('Invalid code. Please try again.')
        setCode('')
        codeInputRef.current?.focus()
        return
      }
      // Success — fetch factor details for enrolled state
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const verified = factors?.totp?.find((f) => f.status === 'verified')
      setEnrolledFactor(
        verified
          ? { id: verified.id, friendly_name: verified.friendly_name, created_at: verified.created_at }
          : { id: enrollData.factorId, created_at: new Date().toISOString() }
      )
      setEnrollData(null)
      setState('enrolled')
    })
  }

  const handleCancelSetup = async () => {
    // Clean up the unverified factor before cancelling
    if (enrollData?.factorId) {
      await supabase.auth.mfa.unenroll({ factorId: enrollData.factorId }).catch(() => {})
    }
    setEnrollData(null)
    setCode('')
    setError(null)
    setState('idle')
  }

  const handleDisable = () => {
    if (!enrolledFactor) return
    setError(null)
    startTransition(async () => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: enrolledFactor.id })
      if (error) {
        setError(error.message ?? 'Failed to disable 2FA. Please try again.')
        setShowDisableConfirm(false)
        return
      }
      setEnrolledFactor(null)
      setShowDisableConfirm(false)
      setState('idle')
    })
  }

  const handleCopySecret = async () => {
    if (!enrollData?.secret) return
    await navigator.clipboard.writeText(enrollData.secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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

  // ── Loading ──────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-gray-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-xs">Loading…</span>
      </div>
    )
  }

  // ── Enrolled ─────────────────────────────────────────────────────────────
  if (state === 'enrolled') {
    return (
      <>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
            <ShieldCheck className="w-3 h-3" />
            Enabled
          </span>
          <button
            onClick={() => setShowDisableConfirm(true)}
            className="text-xs text-red-600 hover:text-red-700 underline underline-offset-2"
          >
            Disable
          </button>
        </div>
        {error && <InlineError message={error} />}
        {showDisableConfirm && (
          <ConfirmDisableModal
            onConfirm={handleDisable}
            onCancel={() => setShowDisableConfirm(false)}
            loading={isPending}
          />
        )}
      </>
    )
  }

  // ── Setup (Enrolling) ────────────────────────────────────────────────────
  if (state === 'setup' && enrollData) {
    return (
      <>
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-4.5 h-4.5 text-blue-600" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Set up two-factor authentication</h2>
                <p className="text-xs text-gray-500">Scan the QR code with your authenticator app</p>
              </div>
            </div>

            {/* QR Code */}
            <div className="flex justify-center mb-4">
              <div className="border border-gray-200 rounded-lg p-3 bg-white inline-block">
                <img
                  src={enrollData.qrCode}
                  alt="TOTP QR Code"
                  className="w-44 h-44"
                />
              </div>
            </div>

            <p className="text-xs text-center text-gray-500 mb-3">
              Works with Google Authenticator, Authy, 1Password, and other TOTP apps.
            </p>

            {/* Manual entry secret */}
            <div className="mb-4">
              <p className="text-xs text-gray-500 mb-1.5">Or enter this code manually:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded px-2.5 py-2 tracking-widest text-gray-700 break-all">
                  {enrollData.secret}
                </code>
                <button
                  onClick={handleCopySecret}
                  className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
                  title="Copy secret"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Code input */}
            <div className="mb-4">
              <label className="text-xs font-medium text-gray-700 mb-1.5 block">
                Enter the 6-digit code to verify
              </label>
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
                placeholder="000000"
                className="w-full text-center text-2xl font-mono tracking-[0.5em] border border-gray-200 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder:text-gray-300 placeholder:tracking-normal"
              />
              {error && <InlineError message={error} />}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={handleCancelSetup}
                disabled={isPending}
                className="text-gray-600"
              >
                Cancel
              </Button>
              <Button
                onClick={handleVerify}
                disabled={code.length !== 6 || isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {isPending ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Verifying…
                  </span>
                ) : (
                  'Verify & Enable'
                )}
              </Button>
            </div>
          </div>
        </div>
        {/* Placeholder so the row doesn't collapse */}
        <span className="text-xs text-gray-400">Setting up…</span>
      </>
    )
  }

  // ── Idle (not enrolled) ──────────────────────────────────────────────────
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleEnable}
        disabled={isPending}
        className="border-gray-200 text-gray-700 hover:bg-gray-50 text-xs"
      >
        {isPending ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading…
          </span>
        ) : (
          'Enable'
        )}
      </Button>
      {error && <InlineError message={error} />}
    </>
  )
}
