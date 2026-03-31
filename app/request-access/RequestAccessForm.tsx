'use client'

import { useState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { submitAccessRequest } from '@/lib/actions/invites'

const CALENDLY = 'https://calendly.com/mine-ai/demo'

const ROLE_OPTIONS = [
  { value: '', label: 'Select one…' },
  { value: 'Currently in a data migration', label: 'Currently in a data migration' },
  { value: 'Planning a migration in the next 6 months', label: 'Planning a migration in the next 6 months' },
  { value: 'Evaluating migration tools', label: 'Evaluating migration tools' },
  { value: 'Systems integrator or consultant', label: 'Systems integrator or consultant' },
  { value: 'Other', label: 'Other' },
]

export default function RequestAccessForm() {
  const searchParams = useSearchParams()
  const ref = searchParams.get('ref') || 'general'
  const isAssessment = ref === 'assessment'
  const [isPending, startTransition] = useTransition()
  const [submitted, setSubmitted] = useState(false)
  const [submittedName, setSubmittedName] = useState('')
  const [submittedEmail, setSubmittedEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    role_type: '',
    systems_involved: '',
    additional_notes: '',
  })

  const set = (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
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
    if (!form.role_type) errs.role_type = 'Please select an option.'
    return errs
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const errs = validate()
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }

    startTransition(async () => {
      const result = await submitAccessRequest({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        company: form.company.trim(),
        role_type: form.role_type,
        systems_involved: form.systems_involved || undefined,
        additional_notes: form.additional_notes || undefined,
        ref,
      })

      if (!result.success) {
        setError(result.error ?? 'Something went wrong. Please try again or email us at kaan@trymine.ai')
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
            <img src="/Mine Logo no background.png" alt="Mine" className="h-10 w-auto mx-auto" />
          </Link>

          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h1 className="text-2xl font-bold text-gray-900 mb-2">Thanks, {submittedName}!</h1>
            <p className="text-gray-500 text-sm leading-relaxed mb-8">
              We&apos;re reviewing your request and will be in touch at{' '}
              <span className="font-medium text-gray-700">{submittedEmail}</span> within 24 hours.
            </p>

            <div className="border-t border-gray-100 pt-7">
              <p className="text-sm font-medium text-gray-700 mb-4">
                Want to see Mine in action right away?
              </p>
              <a
                href={CALENDLY}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-all text-sm text-center mb-3"
              >
                Book a Demo
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
          <img src="/Mine Logo no background.png" alt="Mine" className="h-10 w-auto mx-auto" />
        </Link>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 lg:p-10">
          <div className="mb-7">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {isAssessment ? 'Get Your Free Migration Assessment' : 'Tell us about your migration'}
            </h1>
            <p className="text-sm text-gray-500 leading-relaxed">
              We&apos;ll review your requirements and share a preliminary assessment within 48 hours.
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

            <Field label="What best describes you?" required error={fieldErrors.role_type}>
              <select
                value={form.role_type}
                onChange={set('role_type')}
                className={inputCls(fieldErrors.role_type)}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.value === ''}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="What systems are involved?" hint="Optional">
              <textarea
                rows={3}
                placeholder="e.g., SAP ECC to S/4HANA, Salesforce Classic to Lightning, Legacy CRM to Salesforce…"
                value={form.systems_involved}
                onChange={set('systems_involved')}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none transition"
              />
            </Field>

            <Field label="Anything else we should know?" hint="Optional">
              <textarea
                rows={3}
                placeholder="Timeline, team size, specific challenges…"
                value={form.additional_notes}
                onChange={set('additional_notes')}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none transition"
              />
            </Field>

            <button
              type="submit"
              disabled={isPending}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-all text-sm mt-2"
            >
              {isPending ? 'Submitting…' : isAssessment ? 'Get Your Free Assessment' : 'Get Your Assessment'}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-5">
            Already have an invite code?{' '}
            <Link href="/signup" className="text-blue-600 hover:text-blue-700 font-medium">
              Sign up here
            </Link>
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
