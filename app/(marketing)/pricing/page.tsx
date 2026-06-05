import type { Metadata } from 'next'
import Link from 'next/link'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import PricingEstimator from '@/components/pricing/PricingEstimator'
import PricingFAQ from '@/components/pricing/PricingFAQ'
import { ScrollReveal } from '@/components/ui/ScrollReveal'

export const metadata: Metadata = {
  title: 'Pricing — Settle | AI-Native Data Migration',
  description:
    'Get an instant migration estimate. Settle replaces months of consulting work with an AI-native platform. Pricing based on migration complexity.',
  openGraph: {
    title: 'Pricing — Settle | AI-Native Data Migration',
    description:
      'Get an instant migration estimate. Settle replaces months of consulting work with an AI-native platform.',
    url: 'https://settledata.ai/pricing',
    siteName: 'Settle',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pricing — Settle | AI-Native Data Migration',
    description:
      'Get an instant migration estimate. Pricing based on migration complexity.',
  },
}

const CALENDLY_URL = 'https://calendly.com/settle-ai/migration-scoping-call'

const CONSULTING_ROWS = [
  { label: 'Timeline', value: '3–12 months' },
  { label: 'Cost (mid-market)', value: '$75K–$250K' },
  { label: 'Team size', value: '3–6 consultants' },
  { label: 'Rework cycles', value: '3–5 rounds typical' },
]

const SETTLE_ROWS = [
  { label: 'Timeline', value: '1–8 weeks' },
  { label: 'Cost', value: '$2,500–$20,000' },
  { label: 'Team size', value: 'Your existing team' },
  { label: 'Validation', value: 'AI-validated before delivery' },
]

function ComparisonCard({
  title,
  rows,
  variant,
}: {
  title: string
  rows: { label: string; value: string }[]
  variant: 'muted' | 'accent'
}) {
  const isAccent = variant === 'accent'
  return (
    <div
      className={
        isAccent
          ? 'bg-blue-50 border-2 border-[#2358D4] rounded-xl p-8'
          : 'bg-white border border-[#E2E8F0] rounded-xl p-8 opacity-60'
      }
    >
      <p
        className={`text-lg font-semibold mb-6 ${isAccent ? 'text-[#0F172A]' : 'text-[#334155]'}`}
      >
        {title}
      </p>
      {rows.map((row, i) => (
        <div key={row.label} className={i > 0 ? 'border-t border-[#E2E8F0] pt-4 mt-4' : ''}>
          <p className="text-xs uppercase tracking-wider text-[#94A3B8] mb-1">{row.label}</p>
          <p className={`text-xl font-bold ${isAccent ? 'text-[#0F172A]' : 'text-[#334155]'}`}>
            {row.value}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function PricingPage() {
  return (
    <>
      <Header />

      {/* Hero */}
      <section className="bg-white pt-24 pb-12 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#2358D4] mb-4">
            Pricing
          </p>
          <h1 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight leading-tight">
            Migration pricing that replaces consulting budgets
          </h1>
          <p className="text-lg text-[#64748B] mt-4 max-w-xl mx-auto">
            Answer 4 questions about your migration and get an instant estimate.
          </p>
        </div>
      </section>

      {/* Estimator */}
      <section id="estimator" className="py-8 px-6">
        <PricingEstimator />
      </section>

      {/* Value Comparison */}
      <section className="py-20 px-6 bg-[#F8FAFC]">
        <div className="max-w-5xl mx-auto">
          <ScrollReveal>
            <h2 className="text-3xl font-bold text-[#0F172A] tracking-tight text-center">
              How Settle compares
            </h2>
            <p className="text-base text-[#64748B] text-center mt-3 mb-12">
              What used to require a team of consultants, Settle delivers as a platform.
            </p>
          </ScrollReveal>

          <ScrollReveal delay={0.1}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <ComparisonCard
                title="Traditional consulting"
                rows={CONSULTING_ROWS}
                variant="muted"
              />
              <ComparisonCard title="With Settle" rows={SETTLE_ROWS} variant="accent" />
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="py-20 px-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-[#0F172A] tracking-tight text-center mb-12">
            Pricing FAQ
          </h2>
          <PricingFAQ />
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="bg-[#0F172A] py-20 px-6">
        <div className="max-w-xl mx-auto text-center">
          <h2 className="text-4xl font-bold text-white tracking-tight">
            Consider it settled.
          </h2>
          <p className="text-[#94A3B8] mt-4">
            Tell us about your upcoming migration. We'll follow up within 48 hours — at no cost.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4 mt-8">
            <Link
              href="#estimator"
              className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-4 rounded-xl text-base transition-all text-center"
            >
              Get an Estimate
            </Link>
            <Link
              href={CALENDLY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-[#475569] text-[#CBD5E1] font-semibold px-8 py-4 rounded-xl hover:bg-[#1E293B] text-base transition-all text-center"
            >
              Book a Scoping Call
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </>
  )
}
