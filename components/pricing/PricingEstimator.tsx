'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { createClient } from '@/lib/supabase/client'

type EstimatorStep = 'q1' | 'q2' | 'q3' | 'q4' | 'result' | 'form' | 'confirmation'

interface PricingResult {
  tier: 'starter' | 'growth' | 'scale' | 'enterprise'
  priceRange: string
  description: string
  alternativeCost: string
}

const QUESTIONS = {
  q1: {
    title: 'What type of systems are you migrating?',
    options: [
      { value: 'erp', label: 'ERP', description: 'SAP, Oracle, NetSuite' },
      { value: 'crm', label: 'CRM', description: 'Salesforce, HubSpot, Dynamics' },
      { value: 'legal', label: 'Legal / GRC', description: 'SimpleLegal, TeamConnect' },
      { value: 'hris', label: 'HRIS', description: 'Workday, ADP, BambooHR' },
      { value: 'other', label: 'Other', description: 'Custom or proprietary systems' },
    ],
  },
  q2: {
    title: 'How many source systems are you migrating from?',
    options: [
      { value: '1', label: '1 system', description: 'Single source migration' },
      { value: '2-3', label: '2–3 systems', description: 'Multi-system consolidation' },
      { value: '4+', label: '4+ systems', description: 'Large-scale platform migration' },
    ],
  },
  q3: {
    title: 'Approximate number of data tables',
    options: [
      { value: 'under-50', label: 'Under 50', description: 'Small migration' },
      { value: '50-200', label: '50–200', description: 'Mid-scale migration' },
      { value: '200-500', label: '200–500', description: 'Large migration' },
      { value: '500+', label: '500+', description: 'Enterprise-scale' },
      { value: 'not-sure', label: 'Not sure', description: "We'll help you scope it" },
    ],
  },
  q4: {
    title: 'When do you need this completed?',
    options: [
      { value: 'under-4-weeks', label: 'Under 4 weeks', description: 'Urgent timeline' },
      { value: '1-3-months', label: '1–3 months', description: 'Standard timeline' },
      { value: '3+-months', label: '3+ months', description: 'Planning ahead' },
      { value: 'exploring', label: 'Just exploring', description: 'No timeline yet' },
    ],
  },
}

const CALENDLY_URL = 'https://calendly.com/settle-ai/migration-scoping-call'

function calculatePricing(tables: string, systems: string): PricingResult {
  if (tables === '500+' || (tables === '200-500' && systems === '4+')) {
    return {
      tier: 'enterprise',
      priceRange: 'Custom',
      description:
        'Enterprise migrations with 500+ tables require a custom assessment to ensure accuracy.',
      alternativeCost: '$500K–$2M+',
    }
  }
  if (tables === '200-500') {
    return {
      tier: 'scale',
      priceRange: '$15,000 – $20,000',
      description: 'Large-scale migration with 200–500 tables.',
      alternativeCost: '$250K–$750K',
    }
  }
  if (tables === '50-200' || (tables === 'under-50' && systems === '4+')) {
    return {
      tier: 'growth',
      priceRange: '$5,000 – $8,000',
      description: 'Mid-scale migration with 50–200 tables.',
      alternativeCost: '$75K–$250K',
    }
  }
  if (tables === 'not-sure') {
    return {
      tier: 'growth',
      priceRange: '$5,000 – $15,000',
      description: 'Most mid-market migrations fall in this range.',
      alternativeCost: '$75K–$250K',
    }
  }
  return {
    tier: 'starter',
    priceRange: '$2,500 – $5,000',
    description: 'Focused migration with under 50 tables.',
    alternativeCost: '$25K–$75K',
  }
}

function getResultDescription(
  systemType: string,
  sourceCount: string,
  tableCount: string,
): string {
  const systemLabels: Record<string, string> = {
    erp: 'ERP',
    crm: 'CRM',
    legal: 'Legal/GRC',
    hris: 'HRIS',
    other: 'custom system',
  }
  const sys = systemLabels[systemType] || 'system'
  const tables =
    tableCount === 'not-sure'
      ? ''
      : ` with ${QUESTIONS.q3.options.find((o) => o.value === tableCount)?.label || ''} tables`
  const sources =
    sourceCount === '1'
      ? ''
      : ` across ${QUESTIONS.q2.options.find((o) => o.value === sourceCount)?.label || ''} source systems`
  return `Estimated for a ${sys} migration${tables}${sources}.`
}

const slideVariants = {
  enter: { opacity: 0, x: 20 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
}

const STEP_ORDER: EstimatorStep[] = ['q1', 'q2', 'q3', 'q4', 'result']

function getStepNumber(step: EstimatorStep): number {
  const map: Record<string, number> = { q1: 1, q2: 2, q3: 3, q4: 4 }
  return map[step] ?? 0
}

export default function PricingEstimator() {
  const [step, setStep] = useState<EstimatorStep>('q1')
  const [systemType, setSystemType] = useState('')
  const [sourceCount, setSourceCount] = useState('')
  const [tableCount, setTableCount] = useState('')
  const [timeline, setTimeline] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)

  function resetAll() {
    setStep('q1')
    setSystemType('')
    setSourceCount('')
    setTableCount('')
    setTimeline('')
    setName('')
    setEmail('')
    setCompany('')
    setRole('')
    setIsSubmitting(false)
    setError('')
    setShowForm(false)
  }

  function goBack() {
    const idx = STEP_ORDER.indexOf(step)
    if (idx > 0) setStep(STEP_ORDER[idx - 1])
  }

  function selectAndAdvance(
    setter: (v: string) => void,
    value: string,
    next: EstimatorStep,
  ) {
    setter(value)
    setTimeout(() => setStep(next), 300)
  }

  async function handleSubmit() {
    if (!name.trim() || !email.trim() || !company.trim()) {
      setError('Please fill in all required fields.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid work email.')
      return
    }

    setIsSubmitting(true)
    setError('')

    const pricing = calculatePricing(tableCount, sourceCount)

    try {
      const supabase = createClient()
      const { error: dbError } = await supabase.from('pricing_leads').insert({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        company: company.trim(),
        role: role.trim() || null,
        system_type: systemType,
        source_system_count: sourceCount,
        table_count_range: tableCount,
        timeline,
        computed_tier: pricing.tier,
        price_range_shown: pricing.priceRange,
      })
      if (dbError) throw dbError

      try {
        await fetch('/api/notify-pricing-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            company: company.trim(),
            role: role.trim(),
            system_type: systemType,
            source_system_count: sourceCount,
            table_count_range: tableCount,
            timeline,
            computed_tier: pricing.tier,
            price_range_shown: pricing.priceRange,
          }),
        })
      } catch (emailError) {
        console.error('Email notification failed:', emailError)
      }

      setStep('confirmation')
    } catch (err) {
      console.error('Submission error:', err)
      setError('Something went wrong. Please try again or book a call directly.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const pricing = calculatePricing(tableCount, sourceCount)
  const isQuestionStep = ['q1', 'q2', 'q3', 'q4'].includes(step)
  const stepNumber = getStepNumber(step)

  return (
    <div className="max-w-2xl mx-auto py-8 min-h-[400px]">
      <AnimatePresence mode="wait">
        {/* Question Steps */}
        {isQuestionStep && (
          <motion.div
            key={step}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.3 }}
          >
            {/* Progress */}
            <div className="mb-8">
              <p className="text-xs font-medium text-[#64748B] text-center mb-3 tracking-wide uppercase">
                Step {stepNumber} of 4
              </p>
              <div className="h-1 bg-[#E2E8F0] rounded-full overflow-hidden max-w-xs mx-auto">
                <div
                  className="h-full bg-[#2358D4] rounded-full transition-all duration-500"
                  style={{ width: `${(stepNumber / 4) * 100}%` }}
                />
              </div>
            </div>

            {/* Question Title */}
            <h2 className="text-2xl font-bold text-[#0F172A] tracking-tight text-center mb-8">
              {QUESTIONS[step as keyof typeof QUESTIONS].title}
            </h2>

            {/* Options Grid */}
            <div
              className={
                QUESTIONS[step as keyof typeof QUESTIONS].options.length === 3
                  ? 'grid grid-cols-1 sm:grid-cols-3 gap-4'
                  : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'
              }
            >
              {QUESTIONS[step as keyof typeof QUESTIONS].options.map((option) => {
                const currentValue =
                  step === 'q1'
                    ? systemType
                    : step === 'q2'
                      ? sourceCount
                      : step === 'q3'
                        ? tableCount
                        : timeline
                const isSelected = currentValue === option.value

                return (
                  <button
                    key={option.value}
                    onClick={() => {
                      const nextStep: EstimatorStep =
                        step === 'q1'
                          ? 'q2'
                          : step === 'q2'
                            ? 'q3'
                            : step === 'q3'
                              ? 'q4'
                              : 'result'
                      const setter =
                        step === 'q1'
                          ? setSystemType
                          : step === 'q2'
                            ? setSourceCount
                            : step === 'q3'
                              ? setTableCount
                              : setTimeline
                      selectAndAdvance(setter, option.value, nextStep)
                    }}
                    className={
                      isSelected
                        ? 'border-2 border-[#2358D4] bg-blue-50 rounded-xl p-5 text-left transition-all'
                        : 'border border-[#E2E8F0] rounded-xl p-5 cursor-pointer hover:border-[#2358D4] hover:bg-blue-50/30 transition-all text-left'
                    }
                  >
                    <p className="text-base font-semibold text-[#0F172A]">{option.label}</p>
                    <p className="text-sm text-[#64748B] mt-1">{option.description}</p>
                  </button>
                )
              })}
            </div>

            {/* Back Button */}
            {step !== 'q1' && (
              <div className="mt-6 text-center">
                <button
                  onClick={goBack}
                  className="text-sm text-[#64748B] hover:text-[#0F172A] transition-colors"
                >
                  ← Back
                </button>
              </div>
            )}
          </motion.div>
        )}

        {/* Result Screen */}
        {step === 'result' && (
          <motion.div
            key="result"
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.3 }}
          >
            {pricing.tier !== 'enterprise' ? (
              <>
                <p className="text-5xl md:text-6xl font-bold text-[#0F172A] tracking-tight text-center">
                  {pricing.priceRange}
                </p>
                <p className="text-base text-[#64748B] text-center mt-3">
                  {getResultDescription(systemType, sourceCount, tableCount)}
                </p>
                <p className="text-sm text-[#475569] text-center mt-6 max-w-xl mx-auto">
                  Includes full platform access, guided setup for your first migration, and complete
                  migration delivery.
                </p>

                <div className="flex flex-col sm:flex-row justify-center gap-4 mt-8">
                  <button
                    onClick={() => setShowForm(true)}
                    className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm"
                  >
                    Get your detailed estimate
                  </button>
                  <Link
                    href={CALENDLY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border border-[#CBD5E1] text-[#334155] font-semibold px-8 py-3.5 rounded-xl hover:bg-[#F8FAFC] transition-all text-sm text-center"
                  >
                    Book a scoping call →
                  </Link>
                </div>

                <p className="text-sm text-[#94A3B8] text-center mt-6">
                  Traditional consulting for this migration class:{' '}
                  <span className="font-medium">{pricing.alternativeCost}</span>
                </p>
              </>
            ) : (
              <>
                <h2 className="text-3xl font-bold text-[#0F172A] text-center">
                  Let's scope this together
                </h2>
                <p className="text-base text-[#64748B] text-center mt-3 max-w-lg mx-auto">
                  Enterprise migrations with 500+ tables require a custom assessment. We'll walk
                  through your data landscape and provide a detailed proposal within 48 hours.
                </p>

                <div className="flex flex-col sm:flex-row justify-center gap-4 mt-8">
                  <Link
                    href={CALENDLY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm text-center"
                  >
                    Book a scoping call
                  </Link>
                  <button
                    onClick={() => setShowForm(true)}
                    className="border border-[#CBD5E1] text-[#334155] font-semibold px-8 py-3.5 rounded-xl hover:bg-[#F8FAFC] transition-all text-sm"
                  >
                    Leave your details
                  </button>
                </div>
              </>
            )}

            {/* Lead Capture Form */}
            <AnimatePresence>
              {showForm && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.35 }}
                  className="overflow-hidden"
                >
                  <div className="max-w-md mx-auto mt-8 space-y-4">
                    <input
                      type="text"
                      required
                      placeholder="Full name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-lg text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#2358D4] focus:border-transparent bg-white"
                    />
                    <input
                      type="email"
                      required
                      placeholder="Work email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-lg text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#2358D4] focus:border-transparent bg-white"
                    />
                    <input
                      type="text"
                      required
                      placeholder="Company name"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-lg text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#2358D4] focus:border-transparent bg-white"
                    />
                    <input
                      type="text"
                      placeholder="Role or title (optional)"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-lg text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#2358D4] focus:border-transparent bg-white"
                    />

                    {error && <p className="text-sm text-red-600 mt-2">{error}</p>}

                    <button
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                      className="w-full py-3.5 bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold rounded-xl text-sm transition-all mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isSubmitting ? 'Submitting…' : 'Get Estimate'}
                    </button>

                    <p className="text-sm text-[#64748B] hover:text-[#2358D4] text-center mt-3 transition-colors">
                      <Link
                        href={CALENDLY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[#2358D4] transition-colors"
                      >
                        Or book a scoping call →
                      </Link>
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Start Over */}
            <p className="text-xs text-[#94A3B8] hover:text-[#2358D4] text-center mt-6 cursor-pointer transition-colors">
              <button onClick={resetAll} className="hover:text-[#2358D4] transition-colors">
                Start over
              </button>
            </p>
          </motion.div>
        )}

        {/* Confirmation Screen */}
        {step === 'confirmation' && (
          <motion.div
            key="confirmation"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.35 }}
            className="text-center"
          >
            <svg
              className="w-12 h-12 text-emerald-500 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>

            <h2 className="text-2xl font-bold text-[#0F172A] text-center mt-4">
              Thanks, {name.trim().split(' ')[0]}.
            </h2>
            <p className="text-base text-[#64748B] text-center mt-2">
              We'll send your detailed estimate to{' '}
              <span className="font-medium text-[#475569]">{email.trim().toLowerCase()}</span> within
              24 hours.
            </p>

            <p className="text-sm text-[#475569] text-center mt-6">
              Want to get started sooner?
            </p>
            <div className="flex justify-center mt-2">
              <Link
                href={CALENDLY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl text-sm transition-all"
              >
                Book a scoping call →
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
