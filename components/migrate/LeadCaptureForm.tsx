'use client'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface LeadCaptureFormProps {
  sourceSystem: string
  targetSystem: string
  slug: string
}

const TIMELINE_OPTIONS = [
  'This quarter',
  'Next quarter',
  'Next 6 months',
  'Exploring',
]

const VOLUME_OPTIONS = [
  'Under 100K rows',
  '100K–1M rows',
  '1M–10M rows',
  'Over 10M rows',
]

const CALENDLY = 'https://calendly.com/mine-ai/demo'

export default function LeadCaptureForm({ sourceSystem, targetSystem, slug }: LeadCaptureFormProps) {
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [timeline, setTimeline] = useState('')
  const [volume, setVolume] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setError(null)

    if (!company.trim() || !email.trim()) {
      setError('Please enter your company name and work email.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid work email address.')
      return
    }

    setSubmitting(true)
    try {
      const { error: dbError } = await supabase.from('leads').insert({
        company_name: company.trim(),
        email: email.trim(),
        migration_timeline: timeline || null,
        data_volume: volume || null,
        source: 'migrate-page',
        migration_slug: slug,
        source_system: sourceSystem,
        target_system: targetSystem,
      })

      if (dbError) throw dbError
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="bg-mine-slate-50 rounded-2xl border border-mine-slate-200 px-8 py-12 text-center">
        <div className="w-12 h-12 bg-mine-teal-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-mine-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-mine-slate-900 mb-2">You're on the list</h3>
        <p className="text-mine-slate-500 text-sm leading-relaxed mb-6">
          We'll be in touch shortly about your {sourceSystem} → {targetSystem} migration.
          In the meantime, feel free to book a demo.
        </p>
        <a
          href={CALENDLY}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block bg-mine-blue-600 hover:bg-mine-blue-700 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25"
        >
          Book a demo
        </a>
      </div>
    )
  }

  return (
    <div className="bg-mine-slate-50 rounded-2xl border border-mine-slate-200 px-8 py-10">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-mine-slate-700 mb-1.5">
              Company name
            </label>
            <input
              type="text"
              placeholder="Acme Corp"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-mine-slate-200 bg-white text-mine-slate-900 text-sm placeholder:text-mine-slate-300 focus:outline-none focus:ring-2 focus:ring-mine-blue-500/30 focus:border-mine-blue-400 transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-mine-slate-700 mb-1.5">
              Work email
            </label>
            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-mine-slate-200 bg-white text-mine-slate-900 text-sm placeholder:text-mine-slate-300 focus:outline-none focus:ring-2 focus:ring-mine-blue-500/30 focus:border-mine-blue-400 transition-all"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-mine-slate-700 mb-1.5">
              Migration timeline
            </label>
            <select
              value={timeline}
              onChange={(e) => setTimeline(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-mine-slate-200 bg-white text-mine-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-mine-blue-500/30 focus:border-mine-blue-400 transition-all appearance-none"
            >
              <option value="">Select timeline…</option>
              {TIMELINE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-mine-slate-700 mb-1.5">
              Estimated data volume
            </label>
            <select
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-mine-slate-200 bg-white text-mine-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-mine-blue-500/30 focus:border-mine-blue-400 transition-all appearance-none"
            >
              <option value="">Select volume…</option>
              {VOLUME_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full bg-mine-blue-600 hover:bg-mine-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25"
        >
          {submitting ? 'Submitting…' : 'Get Started'}
        </button>
      </div>

      <p className="mt-4 text-center text-xs text-mine-slate-400">
        Or{' '}
        <a
          href={CALENDLY}
          target="_blank"
          rel="noopener noreferrer"
          className="text-mine-blue-600 hover:underline"
        >
          book a demo →
        </a>
      </p>
    </div>
  )
}
