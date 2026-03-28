import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

import Header from '@/components/Header'
import Footer from '@/components/Footer'
import ScrollReveal from '@/components/ui/ScrollReveal'
import FAQSection from '@/components/migrate/FAQSection'
import LeadCaptureForm from '@/components/migrate/LeadCaptureForm'
import MappingPreview from '@/components/migrate/MappingPreview'
import ProductScreenshot from '@/components/migrate/ProductScreenshot'

export const revalidate = 3600

// ─── Types ───────────────────────────────────────────────────────────────────

interface Challenge {
  title: string
  description: string
}

interface DataObject {
  source_object: string
  target_object: string
  notes: string
}

interface MigrationStats {
  manual_timeline: string
  mine_timeline: string
  manual_cost: string
  cost_reduction: string
  manual_team: string
  mine_team: string
}

interface MigrationPage {
  slug: string
  source_system: string
  target_system: string
  meta_title: string
  meta_description: string
  hero_headline: string
  hero_subheadline: string
  overview_paragraphs: string[]
  challenges: Challenge[]
  data_objects: DataObject[]
  how_mine_helps: string[]
  migration_stats: MigrationStats
  faqs: { question: string; answer: string }[]
  related_slugs: string[]
  is_published: boolean
  bridge_paragraph?: string
}

interface RelatedPage {
  slug: string
  source_system: string
  target_system: string
}

// ─── Supabase (public read-only) ─────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

async function getMigrationPage(slug: string): Promise<MigrationPage | null> {
  const { data, error } = await getSupabase()
    .from('migration_pages')
    .select('*')
    .eq('slug', slug)
    .eq('is_published', true)
    .single()

  if (error || !data) return null
  return data as MigrationPage
}

async function getRelatedPages(slugs: string[]): Promise<RelatedPage[]> {
  if (!slugs?.length) return []
  const { data } = await getSupabase()
    .from('migration_pages')
    .select('slug, source_system, target_system')
    .in('slug', slugs)
    .eq('is_published', true)

  return (data ?? []) as RelatedPage[]
}

// ─── Static Params ────────────────────────────────────────────────────────────

export async function generateStaticParams() {
  const { data } = await getSupabase()
    .from('migration_pages')
    .select('slug')
    .eq('is_published', true)

  return (data ?? []).map((row: { slug: string }) => ({ slug: row.slug }))
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = await getMigrationPage(slug)
  if (!page) return {}

  const canonical = `https://trymine.ai/migrate/${slug}`

  return {
    title: page.meta_title,
    description: page.meta_description,
    alternates: { canonical },
    openGraph: {
      title: page.meta_title,
      description: page.meta_description,
      url: canonical,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: page.meta_title,
      description: page.meta_description,
    },
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function MigrationPageRoute({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const page = await getMigrationPage(slug)

  if (!page) notFound()

  const related = await getRelatedPages(page.related_slugs ?? [])

  const src = page.source_system
  const tgt = page.target_system
  const stats = page.migration_stats ?? {}
  const canonical = `https://trymine.ai/migrate/${slug}`

  // JSON-LD
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (page.faqs ?? []).map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://trymine.ai' },
      { '@type': 'ListItem', position: 2, name: 'Migrations', item: 'https://trymine.ai/migrate' },
      { '@type': 'ListItem', position: 3, name: `${src} to ${tgt}`, item: canonical },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="min-h-screen bg-white">
        <Header />

        <main>
          {/* ── 1. Breadcrumb ─────────────────────────────────────── */}
          <div className="max-w-6xl mx-auto pt-8 pb-4 px-6 lg:px-12">
            <nav className="flex items-center gap-2 text-sm text-mine-slate-400">
              <Link href="/" className="hover:text-mine-slate-700 transition-colors">Home</Link>
              <span className="text-mine-slate-300">›</span>
              <Link href="/migrate" className="hover:text-mine-slate-700 transition-colors">Migrations</Link>
              <span className="text-mine-slate-300">›</span>
              <span className="text-mine-slate-600 font-medium">{src} to {tgt}</span>
            </nav>
          </div>

          {/* ── 2. Hero ───────────────────────────────────────────── */}
          <section className="max-w-6xl mx-auto px-6 lg:px-12 py-12 lg:py-16">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <ScrollReveal>
                <h1 className="text-4xl lg:text-5xl font-bold text-mine-slate-900 tracking-tight mb-4">
                  {page.hero_headline}
                </h1>
                <p className="text-lg text-mine-slate-500 leading-relaxed mb-8">
                  {page.hero_subheadline}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/request-access"
                    className="bg-mine-blue-600 hover:bg-mine-blue-700 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25"
                  >
                    Get Your Free Assessment
                  </Link>
                  <a
                    href="https://calendly.com/mine-ai/demo"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border border-mine-slate-200 text-mine-slate-700 hover:border-mine-blue-400 hover:text-mine-blue-600 text-sm font-semibold px-6 py-3 rounded-lg transition-all"
                  >
                    Book a Demo
                  </a>
                </div>
                <p className="mt-4 text-xs text-mine-slate-400">
                  Now accepting enterprise migration programs
                </p>
              </ScrollReveal>
              <ScrollReveal delay={0.1}>
                <MappingPreview
                  dataObjects={page.data_objects ?? []}
                  sourceSystem={src}
                  targetSystem={tgt}
                />
              </ScrollReveal>
            </div>
          </section>

          {/* ── 3. Stats Bar ──────────────────────────────────────── */}
          <ScrollReveal>
            <section className="bg-mine-slate-900 py-8 px-6 lg:px-12">
              <div className="max-w-6xl mx-auto grid grid-cols-3 gap-8 text-center">
                <div>
                  <p className="text-3xl lg:text-4xl font-bold text-mine-blue-400">{stats.mine_timeline ?? '—'}</p>
                  <p className="text-sm text-mine-slate-400 mt-1">to production-ready mappings</p>
                </div>
                <div>
                  <p className="text-3xl lg:text-4xl font-bold text-mine-teal-400">40–50%</p>
                  <p className="text-sm text-mine-slate-400 mt-1">cost reduction vs. manual migration</p>
                </div>
                <div>
                  <p className="text-3xl lg:text-4xl font-bold text-mine-blue-400">90%+</p>
                  <p className="text-sm text-mine-slate-400 mt-1">average mapping confidence</p>
                </div>
              </div>
              <p className="text-sm text-mine-slate-500 text-center mt-4 italic">
                Most enterprise migrations start 6+ months behind schedule. Yours doesn't have to.
              </p>
            </section>
          </ScrollReveal>

          {/* ── 4. Who This Is For ────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-4 px-6 lg:px-12">
              <p className="max-w-3xl mx-auto text-sm text-mine-slate-500 text-center leading-relaxed">
                This guide is for{' '}
                <span className="font-medium text-mine-slate-700">
                  VPs of IT, data architects, and migration leads
                </span>{' '}
                at companies moving data from {src} to {tgt} — whether you're scoping, planning, or mid-program.
              </p>
            </div>
          </ScrollReveal>

          {/* ── 5. Technical Bridge Paragraph ─────────────────────── */}
          <ScrollReveal>
            <div className="max-w-3xl mx-auto px-6 lg:px-12 py-4">
              <p className="text-base text-mine-slate-600 leading-relaxed text-center">
                {page.bridge_paragraph || `${src} and ${tgt} use fundamentally different data architectures. Mine bridges this structural gap automatically — handling schema profiling, field mapping, data transformation, and validation that typically consumes months of manual effort.`}
              </p>
            </div>
          </ScrollReveal>

          {/* ── 6. E-E-A-T Byline ────────────────────────────────── */}
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-xs text-mine-slate-400 mt-2">
              Based on enterprise migration programs led by Mine's founding team
            </p>
          </div>

          {/* ── 7. How Mine Helps ─────────────────────────────────── */}
          <section className="py-12 px-6 lg:px-12">
            <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-start">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-mine-slate-900 mb-6">
                  How Mine automates your {src} to {tgt} migration
                </h2>
                <ul className="space-y-4">
                  {(page.how_mine_helps ?? []).map((item, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="mt-0.5 shrink-0 w-5 h-5 bg-mine-blue-600 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                      <p className="text-mine-slate-600 leading-relaxed text-sm">{item}</p>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/how-it-works"
                  className="text-mine-blue-600 hover:text-mine-blue-500 text-sm font-medium mt-4 inline-block"
                >
                  See how Mine works end-to-end →
                </Link>
              </ScrollReveal>
              <ScrollReveal delay={0.1}>
                <ProductScreenshot sourceSystem={src} targetSystem={tgt} />
              </ScrollReveal>
            </div>
          </section>

          {/* ── 8. Mid-page CTA ───────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-8 px-6">
              <div className="max-w-3xl mx-auto text-center">
                <p className="text-lg font-medium text-mine-slate-700 mb-6">
                  Get your {src} to {tgt} mapping analysis — see results in under an hour
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <a
                    href="https://calendly.com/mine-ai/demo"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-mine-blue-600 hover:bg-mine-blue-700 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25"
                  >
                    Book a Demo
                  </a>
                  <Link
                    href="/request-access"
                    className="border border-mine-slate-200 text-mine-slate-700 hover:border-mine-blue-400 hover:text-mine-blue-600 text-sm font-semibold px-6 py-3 rounded-lg transition-all"
                  >
                    Request Access
                  </Link>
                </div>
              </div>
            </div>
          </ScrollReveal>

          {/* ── 9. Timeline Comparison ────────────────────────────── */}
          <section className="bg-mine-slate-900 py-12 px-6 lg:px-12">
            <div className="max-w-4xl mx-auto">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-white mb-8 text-center">
                  Migration timeline: manual vs. Mine
                </h2>
              </ScrollReveal>
              <div className="grid md:grid-cols-2 gap-6">
                <ScrollReveal delay={0.05}>
                  <div className="bg-mine-slate-800 rounded-xl p-8 h-full">
                    <p className="text-lg font-semibold text-mine-slate-300 mb-6">
                      Traditional approach
                    </p>
                    <div className="space-y-5">
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">Timeline</p>
                        <p className="text-white text-xl font-bold">{stats.manual_timeline ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">Estimated cost</p>
                        <p className="text-white text-xl font-bold">{stats.manual_cost ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">Team size</p>
                        <p className="text-white text-xl font-bold">{stats.manual_team ?? '—'}</p>
                      </div>
                    </div>
                  </div>
                </ScrollReveal>
                <ScrollReveal delay={0.1}>
                  <div className="bg-mine-blue-600 rounded-xl p-8 h-full flex flex-col">
                    <div className="flex items-start justify-between mb-6">
                      <p className="text-lg font-semibold text-blue-100">With Mine</p>
                      <span className="text-[10px] text-blue-200/60 uppercase tracking-widest">
                        Enterprise benchmarks
                      </span>
                    </div>
                    <div className="space-y-5">
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">Timeline</p>
                        <p className="text-white text-xl font-bold">{stats.mine_timeline ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">Team size</p>
                        <p className="text-white text-xl font-bold">{stats.mine_team ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">Estimated cost</p>
                        <p className="text-white text-xl font-bold">40–50% less</p>
                      </div>
                    </div>
                    <div className="border-t border-blue-400/30 mt-6 pt-4">
                      <p className="text-[10px] uppercase tracking-widest text-blue-200/60 mb-3">Included</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {[
                          'Schema profiling & analysis',
                          'AI-generated field mappings',
                          'Transformation SQL',
                          'Validation & readiness reports',
                          'Production-ready load files',
                        ].map((item) => (
                          <p key={item} className="text-xs text-blue-100/80">
                            <span className="text-blue-200 mr-1">✓</span>{item}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                </ScrollReveal>
              </div>
            </div>
          </section>

          {/* ── 10. Challenges ────────────────────────────────────── */}
          <section className="py-12 px-6 lg:px-12">
            <div className="max-w-6xl mx-auto">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-mine-slate-900 mb-8 text-center">
                  Common challenges migrating from {src} to {tgt}
                </h2>
              </ScrollReveal>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {(page.challenges ?? []).map((challenge, i) => {
                  const dotIdx = challenge.description.indexOf('. ')
                  const hasSplit = dotIdx !== -1
                  return (
                    <ScrollReveal key={i} delay={i * 0.05} className="h-full">
                      <div className="bg-white rounded-xl p-6 border border-mine-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all h-full">
                        <h3 className="text-lg font-semibold text-mine-slate-900 mb-2">
                          {challenge.title}
                        </h3>
                        <p className="text-sm text-mine-slate-500 leading-relaxed">
                          {hasSplit ? (
                            <>
                              <span className="font-semibold text-mine-slate-800">
                                {challenge.description.slice(0, dotIdx + 1)}
                              </span>
                              {challenge.description.slice(dotIdx + 1)}
                            </>
                          ) : (
                            <span className="font-semibold text-mine-slate-800">
                              {challenge.description}
                            </span>
                          )}
                        </p>
                      </div>
                    </ScrollReveal>
                  )
                })}
              </div>
            </div>
          </section>

          {/* ── 11. Data Objects ──────────────────────────────────── */}
          <section className="bg-mine-slate-50 py-12 px-6 lg:px-12">
            <div className="max-w-4xl mx-auto">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-mine-slate-900 mb-2 text-center">
                  {src} to {tgt} field mapping — what data moves
                </h2>
                <p className="text-sm text-mine-slate-500 text-center mb-6">
                  {(page.data_objects ?? []).length} data objects typically migrated
                </p>
              </ScrollReveal>
              <ScrollReveal delay={0.05}>
                <div className="overflow-x-auto rounded-xl border border-mine-slate-200">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-mine-slate-100">
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest">Source Object</th>
                        <th className="px-3 py-3 text-mine-slate-300 text-xs">→</th>
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest">Target Object</th>
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest hidden md:table-cell">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-mine-slate-200">
                      {(page.data_objects ?? []).map((obj, i) => (
                        <tr key={i} className="hover:bg-mine-slate-50 transition-colors">
                          <td className="px-5 py-3 font-mono text-sm text-mine-blue-700 whitespace-nowrap">{obj.source_object}</td>
                          <td className="px-3 py-3 text-mine-slate-300 text-center">→</td>
                          <td className="px-5 py-3 font-mono text-sm text-mine-teal-600 whitespace-nowrap">{obj.target_object}</td>
                          <td className="px-5 py-3 text-sm text-mine-slate-500 hidden md:table-cell">{obj.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-sm text-mine-slate-400 text-center mt-4 italic">
                  Typical enterprise migrations include 500K–10M+ records across these objects. Mine handles profiling and mapping at any scale.
                </p>
              </ScrollReveal>
            </div>
          </section>

          {/* ── 12. $100K Proof Point ─────────────────────────────── */}
          <ScrollReveal>
            <div className="max-w-3xl mx-auto px-6 py-8">
              <blockquote className="border-l-4 border-mine-blue-600 bg-mine-blue-50/50 rounded-r-lg p-6 text-left">
                <p className="text-base text-mine-slate-700 italic leading-relaxed">
                  In one enterprise migration, a single field mapping error in customer master data caused $100K in billing discrepancies that went undetected for 6 months.
                </p>
                <p className="text-sm text-mine-slate-500 mt-3 not-italic">
                  Mine catches these issues before they reach production.
                </p>
              </blockquote>
            </div>
          </ScrollReveal>

          {/* ── 13. Credibility ───────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-6 px-6">
              <p className="max-w-3xl mx-auto text-center text-sm leading-relaxed">
                <span className="font-semibold text-mine-slate-800">
                  Built by a team that led SAP, Oracle, and Salesforce data migration programs for Fortune 500 companies at a Big 4 consulting firm.
                </span>{' '}
                <span className="text-mine-slate-500">
                  Currently in design partnership with enterprise clients running active migration programs.
                </span>
              </p>
            </div>
          </ScrollReveal>

          {/* ── 14. Overview ──────────────────────────────────────── */}
          <section className="bg-mine-slate-50 py-12 px-6 lg:px-12">
            <ScrollReveal className="max-w-3xl mx-auto">
              <h2 className="text-2xl font-bold text-mine-slate-900 mb-6">
                Why companies migrate from {src} to {tgt}
              </h2>
              {(page.overview_paragraphs ?? []).map((para, i, arr) => {
                const isLast = i === arr.length - 1
                return isLast ? (
                  <div key={i} className="border-l-4 border-mine-blue-600 pl-4 bg-mine-blue-50/50 py-3 rounded-r-lg mb-4">
                    <p className="text-mine-slate-600 leading-relaxed">{para}</p>
                  </div>
                ) : (
                  <p key={i} className="text-mine-slate-600 leading-relaxed mb-4">{para}</p>
                )
              })}
              <Link
                href="/migrate"
                className="text-mine-blue-600 hover:text-mine-blue-500 text-sm font-medium mt-4 inline-block"
              >
                Explore all migration paths →
              </Link>
            </ScrollReveal>
          </section>

          {/* ── 15. FAQ ───────────────────────────────────────────── */}
          {(page.faqs ?? []).length > 0 && (
            <section className="py-12 px-6 lg:px-12">
              <div className="max-w-3xl mx-auto">
                <ScrollReveal>
                  <h2 className="text-2xl font-bold text-mine-slate-900 mb-8 text-center">
                    Frequently asked questions
                  </h2>
                </ScrollReveal>
                <FAQSection faqs={page.faqs} />
              </div>
            </section>
          )}

          {/* ── 16. Related Migrations ────────────────────────────── */}
          {related.length >= 2 && (
            <section className="bg-mine-slate-50 py-10 px-6 lg:px-12">
              <div className="max-w-6xl mx-auto">
                <ScrollReveal>
                  <h2 className="text-2xl font-bold text-mine-slate-900 mb-8 text-center">
                    Related migration paths
                  </h2>
                </ScrollReveal>
                <div className={`grid grid-cols-1 gap-6 ${
                  related.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'
                }`}>
                  {related.slice(0, 4).map((rel, i) => (
                    <ScrollReveal key={rel.slug} delay={i * 0.05}>
                      <Link
                        href={`/migrate/${rel.slug}`}
                        className="block bg-white rounded-xl p-6 border border-mine-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all"
                      >
                        <p className="text-lg font-semibold text-mine-slate-900">
                          {rel.source_system} to {rel.target_system}
                        </p>
                        <p className="text-sm text-mine-slate-500 mt-1">
                          {rel.source_system} to {rel.target_system} data migration
                        </p>
                        <p className="text-mine-blue-600 text-sm mt-2">Learn more →</p>
                      </Link>
                    </ScrollReveal>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* ── 17. Lead Capture ──────────────────────────────────── */}
          <section className="py-14 px-6 lg:px-12">
            <div className="max-w-2xl mx-auto text-center">
              <ScrollReveal>
                <h2 className="text-3xl font-bold text-mine-slate-900 mb-4">
                  Ready to migrate from {src} to {tgt}?
                </h2>
                <p className="text-mine-slate-500 mb-4">
                  Tell us about your migration and we'll show you how Mine can help.
                </p>
                <p className="text-sm text-mine-slate-400 mb-4">
                  No commitment required. We'll review your migration scope and share a preliminary assessment within 48 hours.
                </p>
                <div className="flex items-center justify-center gap-6 mb-6">
                  <span className="text-xs text-mine-slate-400">✓ No credit card</span>
                  <span className="text-xs text-mine-slate-400">✓ 48-hour response</span>
                  <span className="text-xs text-mine-slate-400">✓ Free initial assessment</span>
                </div>
              </ScrollReveal>
              <ScrollReveal delay={0.05}>
                <LeadCaptureForm
                  sourceSystem={src}
                  targetSystem={tgt}
                  slug={slug}
                />
                <a
                  href="https://calendly.com/mine-ai/demo"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-mine-blue-600 hover:text-mine-blue-500 mt-4 inline-block"
                >
                  Or book a demo call →
                </a>
              </ScrollReveal>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </>
  )
}
