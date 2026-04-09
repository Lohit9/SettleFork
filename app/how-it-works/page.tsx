import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

export const metadata: Metadata = {
  title: 'How Settle automates data migration — schema profiling to load files',
  description:
    'A step-by-step look at how Settle automates enterprise data migration: AI schema profiling, field mapping with confidence scores, cleansing, ETL generation, and validation — delivering production-ready load files.',
  openGraph: {
    title: 'How Settle automates data migration',
    description:
      'AI schema profiling, field mapping, cleansing, ETL generation, and validation — the full migration lifecycle automated.',
    url: 'https://usesettle.ai/how-it-works',
    siteName: 'Settle',
    type: 'website',
    images: [
      {
        url: 'https://usesettle.ai/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'How Settle automates data migration',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'How Settle automates data migration',
    description:
      'AI schema profiling, field mapping, cleansing, ETL generation, and validation — the full migration lifecycle automated.',
    images: ['https://usesettle.ai/images/og-image.png'],
  },
}

const STEPS = [
  {
    n: '01',
    title: 'Schema understanding',
    description:
      "Settle's agents scan your source systems and learn tables, keys, relationships, and business meaning. Entities and dependencies are mapped automatically. Duplicates and anomalies are flagged before mapping begins. 240-table schemas with 847K rows profiled in under 14 seconds.",
    screenshot: '/images/how-it-works/schema-overview.png',
    alt: 'Settle schema overview showing source and target system schemas side by side',
  },
  {
    n: '02',
    title: 'Auto-mapping & transformation',
    description:
      'Settle proposes and refines field-level mappings into your target model. Mapping specs are generated automatically with confidence scores. Ambiguous mappings are surfaced for human review — the AI never acts without visibility. 90%+ of fields mapped automatically — flagged exceptions sent for human review, not buried in logs.',
    screenshot: '/images/how-it-works/mapping-review.png',
    alt: 'Settle mapping review with AI-generated field mappings and confidence scores',
  },
  {
    n: '03',
    title: 'Cleansing & standardization',
    description:
      'Cleansing becomes a reusable layer instead of one-off scripts. Address normalization, picklist alignment, deduplication, merge logic, and referential integrity fixes are applied systematically across every load cycle. Cleansing rules persist across load cycles — no rebuilding scripts for every run.',
    screenshot: '/images/how-it-works/transform.png',
    alt: 'Settle transform editor with AI-suggested transformations and live data preview',
  },
  {
    n: '04',
    title: 'Generated ETL & loaders',
    description:
      "Settle outputs production-ready SQL, Python, or API-based loaders. Run them in your environment or Settle's runtime. Parameterize for dev, test, and prod with full audit trails. Every transformation carries a full audit trail — what changed, why, and which AI decision produced it.",
    screenshot: '/images/how-it-works/migration-center.png',
    alt: 'Settle migration center showing production-ready output files and migration status',
  },
  {
    n: '05',
    title: 'Validation, reconciliation & delta',
    description:
      'Multi-agent validation ensures safe loads and smooth deltas. Constraint issues, data drift, and schema changes are detected before they break downstream. Each load cycle feeds back into the next — making every iteration faster and safer. 87% first-pass readiness score across migrations. Blocking issues caught before they reach production.',
    screenshot: '/images/how-it-works/validate.png',
    alt: 'Settle validation dashboard with migration readiness score and AI-suggested fixes',
  },
]

function Screenshot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="rounded-2xl overflow-hidden shadow-2xl shadow-slate-900/10 border border-slate-200">
      {/* Browser chrome top bar */}
      <div className="h-8 bg-slate-100 flex items-center px-3 gap-1.5 border-b border-slate-200">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#EF4444' }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#F59E0B' }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#22C55E' }} />
      </div>
      <Image
        src={src}
        alt={alt}
        width={800}
        height={500}
        className="w-full h-auto"
      />
    </div>
  )
}

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: 'How Settle automates enterprise data migration',
            description:
              'A step-by-step breakdown of how Settle automates the full data migration lifecycle — from schema profiling to production-ready load files.',
            step: [
              {
                '@type': 'HowToStep',
                name: 'Schema understanding',
                text: "Settle's agents scan your source systems and learn tables, keys, relationships, and business meaning. Entities and dependencies are mapped automatically.",
              },
              {
                '@type': 'HowToStep',
                name: 'Auto-mapping & transformation',
                text: 'Settle proposes and refines field-level mappings into your target model with confidence scores. Ambiguous mappings are surfaced for human review.',
              },
              {
                '@type': 'HowToStep',
                name: 'Cleansing & standardization',
                text: 'Address normalization, picklist alignment, deduplication, merge logic, and referential integrity fixes are applied systematically across every load cycle.',
              },
              {
                '@type': 'HowToStep',
                name: 'Generated ETL & loaders',
                text: 'Settle outputs production-ready SQL, Python, or API-based loaders parameterized for dev, test, and prod environments with full audit trails.',
              },
              {
                '@type': 'HowToStep',
                name: 'Validation, reconciliation & delta',
                text: 'Multi-agent validation ensures safe loads and smooth deltas. Constraint issues, data drift, and schema changes are detected before they break downstream.',
              },
            ],
          }),
        }}
      />
      <Header />

      <main className="flex-1">
        <div className="max-w-5xl mx-auto py-24 px-6">

          {/* Hero */}
          <h1 className="text-4xl lg:text-5xl font-bold text-[#0F172A] tracking-tight mb-4 text-center">
            How Settle works
          </h1>
          <p className="text-lg text-[#64748B] leading-relaxed text-center max-w-2xl mx-auto mb-16">
            An autonomous, multi-agent workflow that handles the full migration lifecycle — from schema profiling to production-ready load files. First mapping proposals in under an hour. Production-ready packages in days, not months.
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
                    <Screenshot src={step.screenshot} alt={step.alt} />
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
                href="/request-access"
                className="bg-[#2358D4] hover:bg-[#1D4ED8] text-white font-semibold px-8 py-3.5 rounded-xl shadow-lg shadow-blue-600/20 hover:-translate-y-0.5 transition-all text-sm"
              >
                Request Access
              </Link>
              <a
                href="https://calendly.com/settle-ai/demo"
                target="_blank"
                rel="noopener noreferrer"
                className="border border-[#CBD5E1] text-[#0F172A] font-medium px-8 py-3.5 rounded-xl hover:border-[#2358D4] hover:text-[#2358D4] transition-all text-sm"
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
