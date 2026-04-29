'use client'

import { useRef, useState, useTransition } from 'react'
import { submitMigrationLead } from '@/lib/actions/migration-leads'
import { Turnstile, type TurnstileHandle } from '@/components/ui/Turnstile'

const TIMELINE_OPTIONS = [
  'This quarter',
  'Next quarter',
  'Next 6 months',
  'Just exploring',
]

const VOLUME_OPTIONS = [
  'Under 100K rows',
  '100K – 1M rows',
  '1M – 10M rows',
  'Over 10M rows',
]

const INPUT_CLASS =
  'w-full px-4 py-3 rounded-xl border border-settle-slate-200 text-sm text-settle-slate-900 bg-white placeholder:text-settle-slate-300 focus:outline-none focus:border-settle-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all'

interface LeadCaptureFormProps {
  sourceSystem: string
  targetSystem: string
  slug: string
}

export default function LeadCaptureForm({ sourceSystem, targetSystem, slug }: LeadCaptureFormProps) {
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [timeline, setTimeline] = useState('')
  const [volume, setVolume] = useState('')
  const [notes, setNotes] = useState('')
  const [isPending, startTransition] = useTransition()
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  const resetTurnstile = () => {
    turnstileRef.current?.reset()
    setTurnstileToken(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!companyName.trim() || !email.trim()) {
      setError('Please enter your company name and work email.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid work email address.')
      return
    }
    if (!turnstileToken) {
      setError('Please complete the verification challenge.')
      return
    }

    startTransition(async () => {
      const result = await submitMigrationLead({
        email: email.trim(),
        company: companyName.trim(),
        slug,
        sourceSystem,
        targetSystem,
        timeline: timeline || undefined,
        volume: volume || undefined,
        notes: notes.trim() || undefined,
        turnstileToken,
      })

      // Tokens are single-use. Reset on every completion so the user
      // can retry after a server-side rejection without remounting.
      resetTurnstile()

      if (!result.success) {
        setError(result.error)
        return
      }

      setIsSubmitted(true)
    })
  }

  if (isSubmitted) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-12 h-12 rounded-full bg-settle-teal-50 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-settle-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-settle-slate-900 font-semibold text-lg">
          Thanks! We'll be in touch within 24 hours.
        </p>
        <p className="text-settle-slate-500 text-sm text-center">
          We'll reach out to {email} about your {sourceSystem} → {targetSystem} migration.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <p className="text-xs text-settle-slate-400 text-center mb-4 max-w-lg mx-auto italic">
        We'll review your migration scope and follow up within 48 hours to discuss next steps.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <input
          type="text"
          placeholder="Company name"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className={INPUT_CLASS}
          autoComplete="organization"
          required
        />
        <input
          type="email"
          placeholder="Work email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT_CLASS}
          autoComplete="email"
          required
        />
        <select
          value={timeline}
          onChange={(e) => setTimeline(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Migration timeline…</option>
          {TIMELINE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        <select
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Estimated data volume…</option>
          {VOLUME_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>

      <textarea
        placeholder="Anything else about your migration? (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className={`${INPUT_CLASS} mt-4 resize-none`}
      />

      <div className="mt-4">
        <Turnstile
          ref={turnstileRef}
          onVerify={setTurnstileToken}
          onExpire={() => setTurnstileToken(null)}
          onError={() => setTurnstileToken(null)}
          theme="light"
        />
      </div>

      <button
        type="submit"
        disabled={isPending || !turnstileToken}
        className="w-full bg-settle-blue-600 hover:bg-settle-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25 mt-4"
      >
        {isPending ? 'Submitting…' : 'Start Your Migration'}
      </button>
    </form>
  )
}
