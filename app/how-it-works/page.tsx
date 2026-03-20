import type { Metadata } from 'next'
import Link from 'next/link'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

export const metadata: Metadata = {
  title: 'How It Works | Mine',
  description: 'See how Mine automates the full data migration lifecycle from schema profiling to production-ready load files.',
}

const STEPS = [
  {
    n: '01',
    title: 'Schema understanding',
    description:
      "Mine's agents scan your source systems and learn tables, keys, relationships, and business meaning. Entities and dependencies are mapped automatically. Duplicates and anomalies are flagged before mapping begins.",
  },
  {
    n: '02',
    title: 'Auto-mapping & transformation',
    description:
      'Mine proposes and refines field-level mappings into your target model. Mapping specs are generated automatically with confidence scores. Ambiguous mappings are surfaced for human review — the AI never acts without visibility.',
  },
  {
    n: '03',
    title: 'Cleansing & standardization',
    description:
      'Cleansing becomes a reusable layer instead of one-off scripts. Address normalization, picklist alignment, deduplication, merge logic, and referential integrity fixes are applied systematically across every load cycle.',
  },
  {
    n: '04',
    title: 'Generated ETL & loaders',
    description:
      "Mine outputs production-ready SQL, Python, or API-based loaders. Run them in your environment or Mine's runtime. Parameterize for dev, test, and prod with full audit trails.",
  },
  {
    n: '05',
    title: 'Validation, reconciliation & delta',
    description:
      'Multi-agent validation ensures safe loads and smooth deltas. Constraint issues, data drift, and schema changes are detected before they break downstream. Each load cycle feeds back into the next — making every iteration faster and safer.',
  },
]

function Placeholder() {
  return (
    <div className="bg-[#F1F5F9] rounded-xl h-64 flex items-center justify-center">
      <span className="text-[#94A3B8] text-sm">Product screenshot</span>
    </div>
  )
}

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Header />

      <main className="flex-1">
        <div className="max-w-5xl mx-auto py-24 px-6">

          {/* Hero */}
          <h1 className="text-4xl lg:text-5xl font-bold text-[#0F172A] tracking-tight mb-4 text-center">
            How Mine works
          </h1>
          <p className="text-lg text-[#64748B] leading-relaxed text-center max-w-2xl mx-auto mb-16">
            An autonomous, multi-agent workflow that handles the full migration lifecycle — from schema profiling to production-ready load files.
          </p>

          {/* Steps */}
          {STEPS.map((step, i) => {
            const flipped = i % 2 === 1
            return (
              <div key={step.n} className="border-t border-[#F1F5F9] py-16">
                <div className={`grid grid-cols-1 lg:grid-cols-2 gap-12 items-center ${flipped ? 'lg:[direction:rtl]' : ''}`}>
                  {/* Text */}
                  <div className={flipped ? 'lg:[direction:ltr]' : ''}>
                    <div className="text-6xl font-bold text-[#DBEAFE] leading-none mb-2 select-none">
                      {step.n}
                    </div>
                    <h2 className="text-2xl font-bold text-[#0F172A] mb-3">{step.title}</h2>
                    <p className="text-[#475569] leading-relaxed">{step.description}</p>
                  </div>
                  {/* Visual */}
                  <div className={flipped ? 'lg:[direction:ltr]' : ''}>
                    <Placeholder />
                  </div>
                </div>
              </div>
            )
          })}

          {/* Bottom CTA */}
          <div className="bg-[#F8FAFC] rounded-2xl p-12 text-center mt-16">
            <h2 className="text-2xl font-bold text-[#0F172A] mb-3">Ready to see it in action?</h2>
            <p className="text-[#64748B] mb-6">
              Connect your schema and get your first mapping in under an hour.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/signup"
                className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm"
              >
                Get started for free
              </Link>
              <a
                href="https://calendly.com/trymine-info/demo"
                target="_blank"
                rel="noopener noreferrer"
                className="border border-[#CBD5E1] text-[#0F172A] font-medium px-8 py-3.5 rounded-xl hover:border-[#2563EB] hover:text-[#2563EB] transition-all text-sm"
              >
                Book a Demo
              </a>
            </div>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  )
}
