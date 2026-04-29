'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { submitAccessRequest } from '@/lib/actions/invites'
import { Turnstile, type TurnstileHandle } from '@/components/ui/Turnstile'

const CALENDLY = process.env.NEXT_PUBLIC_CALENDLY_SCOPING_URL || 'https://calendly.com/settle-ai/migration-scoping-call'

export default function RequestAccessForm() {
  const [isPending, startTransition] = useTransition()
  const [submitted, setSubmitted] = useState(false)
  const [submittedName, setSubmittedName] = useState('')
  const [submittedEmail, setSubmittedEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    notes: '',
  })

  const set = (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
      if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: '' }))
    }

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!form.name.trim()) errs.name = 'Full name is required.'
    if (!form.email.trim()) {
      errs.email = 'Work email is required.'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = 'Please enter a valid email address.'
    }
    if (!form.company.trim()) errs.company = 'Company is required.'
    return errs
  }

  const resetTurnstile = () => {
    turnstileRef.current?.reset()
    setTurnstileToken(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const errs = validate()
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }

    if (!turnstileToken) {
      setError('Please complete the verification challenge.')
      return
    }

    startTransition(async () => {
      const result = await submitAccessRequest({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        company: form.company.trim(),
        role_type: 'Platform access request',
        additional_notes: form.notes || undefined,
        turnstileToken,
      })

      // Tokens are single-use. Reset the widget on every completion so the
      // user can resubmit after a server-side rejection without remounting.
      resetTurnstile()

      if (!result.success) {
        setError(result.error ?? 'Something went wrong. Please try again or email us at kaan@usesettle.ai')
        return
      }

      setSubmittedName(form.name.split(' ')[0])
      setSubmittedEmail(form.email.trim().toLowerCase())
      setSubmitted(true)
    })
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-16">
        <div className="w-full max-w-md text-center">
          <Link href="/" className="inline-block mb-8">
            <img src="/images/logos/settle-logo-full.svg" alt="Settle" className="h-8 w-auto mx-auto" />
          </Link>

          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h1 className="text-2xl font-bold text-gray-900 mb-2">Thanks, {submittedName}!</h1>
            <p className="text-gray-500 text-sm leading-relaxed mb-8">
              We&apos;ll set up your account and send login credentials to{' '}
              <span className="font-medium text-gray-700">{submittedEmail}</span> within 24 hours.
            </p>

            <div className="border-t border-gray-100 pt-7">
              <p className="text-sm font-medium text-gray-700 mb-4">
                Want to get started sooner?
              </p>
              <a
                href={CALENDLY}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold py-3 rounded-xl transition-all text-sm text-center mb-3"
              >
                Book a Call
              </a>
              <Link href="/" className="block text-sm text-gray-500 hover:text-gray-700 transition-colors">
                ← Back to home
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg">
        <Link href="/" className="inline-block mb-8">
          <img src="/images/logos/settle-logo-full.svg" alt="Settle" className="h-8 w-auto mx-auto" />
        </Link>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 lg:p-10">
          <div className="mb-7">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              Request platform access
            </h1>
            <p className="text-sm text-gray-500 leading-relaxed">
              Already talked to us? We&apos;ll set up your account and send login credentials within 24 hours.
            </p>
          </div>

          {error && (
            <div className="mb-5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Full Name" required error={fieldErrors.name}>
              <input
                type="text"
                placeholder="Jane Smith"
                value={form.name}
                onChange={set('name')}
                className={inputCls(fieldErrors.name)}
                autoComplete="name"
              />
            </Field>

            <Field label="Work Email" required error={fieldErrors.email}>
              <input
                type="email"
                placeholder="you@company.com"
                value={form.email}
                onChange={set('email')}
                className={inputCls(fieldErrors.email)}
                autoComplete="email"
              />
            </Field>

            <Field label="Company" required error={fieldErrors.company}>
              <input
                type="text"
                placeholder="Acme Corp"
                value={form.company}
                onChange={set('company')}
                className={inputCls(fieldErrors.company)}
                autoComplete="organization"
              />
            </Field>

            <Field label="Notes" hint="Optional">
              <textarea
                rows={3}
                placeholder="Any context for your request (optional)"
                value={form.notes}
                onChange={set('notes')}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none transition"
              />
            </Field>

            <Turnstile
              ref={turnstileRef}
              onVerify={setTurnstileToken}
              onExpire={() => setTurnstileToken(null)}
              onError={() => setTurnstileToken(null)}
              theme="light"
            />

            <button
              type="submit"
              disabled={isPending || !turnstileToken}
              className="w-full bg-[#2358D4] hover:bg-[#1D4ED8] disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-all text-sm mt-2"
            >
              {isPending ? 'Submitting…' : 'Request Access'}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-5">
            Already have an invite?{' '}
            Check your email for your invite link.
          </p>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
        {hint && <span className="ml-1 text-gray-400 font-normal">({hint})</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

function inputCls(error?: string) {
  return [
    'w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400',
    'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition',
    error ? 'border-red-300 focus:ring-red-500 focus:border-red-500' : 'border-gray-300',
  ].join(' ')
}
