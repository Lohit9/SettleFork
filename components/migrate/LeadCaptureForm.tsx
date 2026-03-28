'use client'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

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
  'w-full px-4 py-3 rounded-xl border border-mine-slate-200 text-sm text-mine-slate-900 bg-white placeholder:text-mine-slate-300 focus:outline-none focus:border-mine-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all'

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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setError(null)

    if (!companyName.trim() || !email.trim()) {
      setError('Please enter your company name and work email.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid work email address.')
      return
    }

    setIsSubmitting(true)
    try {
      const { error: dbError } = await supabase.from('migration_leads').insert({
        company_name: companyName.trim() || null,
        email: email.trim(),
        source_system: sourceSystem,
        target_system: targetSystem,
        timeline: timeline || null,
        volume: volume || null,
        notes: notes.trim() || null,
        page_slug: slug,
      })

      if (dbError) throw dbError
      setIsSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setIsSubmitting(false)
    }
  }

  if (isSubmitted) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-12 h-12 rounded-full bg-mine-teal-50 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-mine-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-mine-slate-900 font-semibold text-lg">
          Thanks! We'll be in touch within 24 hours.
        </p>
        <p className="text-mine-slate-500 text-sm text-center">
          We'll reach out to {email} about your {sourceSystem} → {targetSystem} migration.
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="text-xs text-mine-slate-400 text-center mb-4 max-w-lg mx-auto italic">
        You'll receive a preliminary mapping analysis showing how your source objects map to your target schema, with confidence scores and flagged risk areas.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <input
          type="text"
          placeholder="Company name"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className={INPUT_CLASS}
        />
        <input
          type="email"
          placeholder="Work email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT_CLASS}
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

      {error && (
        <p className="mt-3 text-sm text-red-500">{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={isSubmitting}
        className="w-full bg-mine-blue-600 hover:bg-mine-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25 mt-2"
      >
        {isSubmitting ? 'Submitting…' : 'Get Your Free Assessment'}
      </button>
    </div>
  )
}
