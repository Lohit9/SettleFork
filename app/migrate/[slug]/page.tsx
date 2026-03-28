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
import MigrationFlowDiagram from '@/components/migrate/MigrationFlowDiagram'
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
  const [page, relatedPages] = await Promise.all([
    getMigrationPage(slug),
    // Fetched eagerly; we'll re-use after confirming page exists
    Promise.resolve([] as RelatedPage[]),
  ])

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
          {/* ── SECTION 1 — Breadcrumb ──────────────────────────────── */}
          <div className="max-w-6xl mx-auto pt-8 pb-4 px-6 lg:px-12">
            <nav className="flex items-center gap-2 text-sm text-mine-slate-400">
              <Link href="/" className="hover:text-mine-slate-700 transition-colors">
                Home
              </Link>
              <span className="text-mine-slate-300">›</span>
              <Link href="/migrate" className="hover:text-mine-slate-700 transition-colors">
                Migrations
              </Link>
              <span className="text-mine-slate-300">›</span>
              <span className="text-mine-slate-600 font-medium">{src} to {tgt}</span>
            </nav>
          </div>

          {/* ── SECTION 2 — Hero ────────────────────────────────────── */}
          <section className="max-w-6xl mx-auto px-6 lg:px-12 py-12 lg:py-20">
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
                    Start Your Migration
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
                  Currently onboarding design partners for enterprise migrations
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

          {/* ── Hero Stats Bar ─────────────────────────────────────── */}
          <ScrollReveal>
            <section className="bg-mine-slate-900 py-6 px-6 lg:px-12">
              <div className="max-w-6xl mx-auto grid grid-cols-3 gap-8 text-center">
                <div>
                  <p className="text-xl font-bold text-white">{stats.manual_timeline ?? '—'}</p>
                  <p className="text-xs text-mine-slate-500 mt-1">manual timeline</p>
                </div>
                <div>
                  <p className="text-xl font-bold text-mine-blue-400">{stats.mine_timeline ?? '—'}</p>
                  <p className="text-xs text-mine-slate-500 mt-1">with Mine</p>
                </div>
                <div>
                  <p className="text-xl font-bold text-mine-teal-400">{stats.cost_reduction ?? '—'}</p>
                  <p className="text-xs text-mine-slate-500 mt-1">cost reduction</p>
                </div>
              </div>
              <p className="text-xs text-mine-slate-500 text-center mt-4 italic">
                Most enterprise migrations start 6+ months behind schedule. Yours doesn't have to.
              </p>
            </section>
          </ScrollReveal>

          {/* ── Who This Is For ─────────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-6 px-6 lg:px-12">
              <p className="max-w-3xl mx-auto text-sm text-mine-slate-500 text-center leading-relaxed">
                This guide is for{' '}
                <span className="font-medium text-mine-slate-700">
                  VPs of IT, data architects, and migration leads
                </span>{' '}
                at companies moving data from {src} to {tgt} — whether you're scoping, planning, or mid-program.
              </p>
            </div>
          </ScrollReveal>

          {/* ── SECTION 3 — Overview ────────────────────────────────── */}
          <section className="bg-mine-slate-50 py-16 px-6 lg:px-12">
            <ScrollReveal className="max-w-3xl mx-auto">
              <h2 className="text-2xl font-bold text-mine-slate-900 mb-6">
                Why companies migrate from {src} to {tgt}
              </h2>
              <p className="text-lg font-semibold text-mine-slate-800 mb-4">
                {src} to {tgt} data migration
              </p>
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

          {/* ── Stats Bar ────────────────────────────────────────────── */}
          <ScrollReveal>
            <section className="bg-mine-slate-900 py-10 px-6">
              <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
                <div>
                  <p className="text-3xl font-bold text-white">{stats.manual_timeline ?? '—'}</p>
                  <p className="text-sm text-mine-slate-400 mt-1">typical manual timeline</p>
                </div>
                <div>
                  <p className="text-3xl font-bold text-mine-blue-400">{stats.mine_timeline ?? '—'}</p>
                  <p className="text-sm text-mine-slate-400 mt-1">with Mine</p>
                </div>
                <div>
                  <p className="text-3xl font-bold text-mine-teal-400">{stats.cost_reduction ?? '—'}</p>
                  <p className="text-sm text-mine-slate-400 mt-1">cost reduction</p>
                </div>
              </div>
            </section>
          </ScrollReveal>

          {/* ── SECTION 4 — Challenges ──────────────────────────────── */}
          <section className="py-16 px-6 lg:px-12">
            <div className="max-w-6xl mx-auto">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-mine-slate-900 mb-8 text-center">
                  Common challenges migrating from {src} to {tgt}
                </h2>
              </ScrollReveal>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {(page.challenges ?? []).map((challenge, i) => (
                  <ScrollReveal key={i} delay={i * 0.05} className="h-full">
                    <div className="bg-white rounded-xl p-6 border border-mine-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all h-full">
                      <h3 className="text-lg font-semibold text-mine-slate-900 mb-2">
                        {challenge.title}
                      </h3>
                      <p className="text-sm text-mine-slate-500 leading-relaxed">
                        {challenge.description}
                      </p>
                    </div>
                  </ScrollReveal>
                ))}
              </div>
            </div>
          </section>

          {/* ── Flow Diagram ──────────────────────────────────────── */}
          <ScrollReveal>
            <MigrationFlowDiagram sourceSystem={src} targetSystem={tgt} />
            <p className="text-sm text-mine-slate-500 text-center max-w-lg mx-auto mt-4 pb-8">
              Mine sits between your source and target systems — profiling, mapping, transforming, and validating automatically.
            </p>
          </ScrollReveal>

          {/* ── SECTION 5 — Data Objects ────────────────────────────── */}
          <section className="bg-mine-slate-50 py-16 px-6 lg:px-12">
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
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest">
                          Source Object
                        </th>
                        <th className="px-3 py-3 text-mine-slate-300 text-xs">→</th>
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest">
                          Target Object
                        </th>
                        <th className="text-left px-5 py-3 text-xs font-semibold text-mine-slate-600 uppercase tracking-widest hidden md:table-cell">
                          Notes
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-mine-slate-200">
                      {(page.data_objects ?? []).map((obj, i) => (
                        <tr key={i} className="hover:bg-mine-slate-50 transition-colors">
                          <td className="px-5 py-3 font-mono text-sm text-mine-blue-700 whitespace-nowrap">
                            {obj.source_object}
                          </td>
                          <td className="px-3 py-3 text-mine-slate-300 text-center">→</td>
                          <td className="px-5 py-3 font-mono text-sm text-mine-teal-600 whitespace-nowrap">
                            {obj.target_object}
                          </td>
                          <td className="px-5 py-3 text-sm text-mine-slate-500 hidden md:table-cell">
                            {obj.notes}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ScrollReveal>
            </div>
          </section>

          {/* ── SECTION 6 — How Mine Helps ──────────────────────────── */}
          <section className="py-16 px-6 lg:px-12">
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

          {/* ── Mid-page CTA ──────────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-12 px-6">
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

          {/* ── SECTION 7 — Timeline Comparison ────────────────────── */}
          <section className="bg-mine-slate-900 py-16 px-6 lg:px-12">
            <div className="max-w-4xl mx-auto">
              <ScrollReveal>
                <h2 className="text-2xl font-bold text-white mb-10 text-center">
                  Migration timeline: manual vs. Mine
                </h2>
              </ScrollReveal>
              <div className="grid md:grid-cols-2 gap-6">
                {/* Manual */}
                <ScrollReveal delay={0.05}>
                  <div className="bg-mine-slate-800 rounded-xl p-8">
                    <p className="text-lg font-semibold text-mine-slate-300 mb-6">
                      Traditional approach
                    </p>
                    <div className="space-y-5">
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">
                          Timeline
                        </p>
                        <p className="text-white text-xl font-bold">{stats.manual_timeline ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">
                          Estimated cost
                        </p>
                        <p className="text-white text-xl font-bold">{stats.manual_cost ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-mine-slate-500 text-xs uppercase tracking-widest mb-1">
                          Team size
                        </p>
                        <p className="text-white text-xl font-bold">{stats.manual_team ?? '—'}</p>
                      </div>
                    </div>
                  </div>
                </ScrollReveal>

                {/* Mine */}
                <ScrollReveal delay={0.1}>
                  <div className="bg-mine-blue-600 rounded-xl p-8">
                    <div className="flex items-start justify-between mb-6">
                      <p className="text-lg font-semibold text-blue-100">With Mine</p>
                      <span className="text-[10px] text-blue-200/60 uppercase tracking-widest">
                        Enterprise benchmarks
                      </span>
                    </div>
                    <div className="space-y-5">
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">
                          Timeline
                        </p>
                        <p className="text-white text-xl font-bold">{stats.mine_timeline ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">
                          Team size
                        </p>
                        <p className="text-white text-xl font-bold">{stats.mine_team ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-blue-200 text-xs uppercase tracking-widest mb-1">
                          Estimated cost
                        </p>
                        <p className="text-white text-xl font-bold">{stats.cost_reduction ? `${stats.cost_reduction} less` : '—'}</p>
                      </div>
                    </div>
                  </div>
                </ScrollReveal>
              </div>
            </div>
          </section>

          {/* ── Credibility Signal ─────────────────────────────────── */}
          <ScrollReveal>
            <div className="py-10 px-6">
              <p className="max-w-3xl mx-auto text-center text-sm leading-relaxed">
                <span className="font-semibold text-mine-slate-800">
                  Built by migration specialists who've led enterprise data programs.
                </span>{' '}
                <span className="text-mine-slate-500">
                  In active design partnership with enterprise clients.
                </span>
              </p>
            </div>
          </ScrollReveal>

          {/* ── SECTION 8 — FAQ ─────────────────────────────────────── */}
          {(page.faqs ?? []).length > 0 && (
            <section className="py-16 px-6 lg:px-12">
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

          {/* ── SECTION 9 — Related Migrations ──────────────────────── */}
          {related.length > 0 && (
            <section className="bg-mine-slate-50 py-16 px-6 lg:px-12">
              <div className="max-w-6xl mx-auto">
                <ScrollReveal>
                  <h2 className="text-2xl font-bold text-mine-slate-900 mb-8 text-center">
                    Related migration paths
                  </h2>
                </ScrollReveal>
                <div className={`grid grid-cols-1 gap-6 ${
                  related.length === 2 ? 'md:grid-cols-2' : related.length >= 3 ? 'md:grid-cols-3' : ''
                }`}>
                  {related.map((rel, i) => (
                    <ScrollReveal key={rel.slug} delay={i * 0.05}>
                      <Link
                        href={`/migrate/${rel.slug}`}
                        className="block bg-white rounded-xl p-6 border border-mine-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all"
                      >
                        <p className="text-lg font-semibold text-mine-slate-900">
                          {rel.source_system} to {rel.target_system}
                        </p>
                        <p className="text-mine-blue-600 text-sm mt-2">Learn more →</p>
                      </Link>
                    </ScrollReveal>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* ── Next Steps ────────────────────────────────────────────── */}
          <ScrollReveal>
            <section className="py-12 px-6 lg:px-12">
              <div className="max-w-3xl mx-auto">
                <h2 className="text-2xl font-bold text-mine-slate-900 text-center mb-8">
                  Get started in 4 steps
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center p-4">
                    <p className="text-2xl font-bold text-mine-blue-200">01</p>
                    <p className="text-sm font-medium text-mine-slate-900 mt-1">Connect your schema</p>
                    <p className="text-xs text-mine-slate-500 mt-1">Upload or connect your {src} data</p>
                  </div>
                  <div className="text-center p-4">
                    <p className="text-2xl font-bold text-mine-blue-200">02</p>
                    <p className="text-sm font-medium text-mine-slate-900 mt-1">Mine profiles your data</p>
                    <p className="text-xs text-mine-slate-500 mt-1">Field-level analysis in 15 minutes</p>
                  </div>
                  <div className="text-center p-4">
                    <p className="text-2xl font-bold text-mine-blue-200">03</p>
                    <p className="text-sm font-medium text-mine-slate-900 mt-1">Review AI mappings</p>
                    <p className="text-xs text-mine-slate-500 mt-1">Approve, edit, or regenerate any mapping</p>
                  </div>
                  <div className="text-center p-4">
                    <p className="text-2xl font-bold text-mine-blue-200">04</p>
                    <p className="text-sm font-medium text-mine-slate-900 mt-1">Export load-ready files</p>
                    <p className="text-xs text-mine-slate-500 mt-1">Production SQL, CSVs, and validation reports</p>
                  </div>
                </div>
              </div>
            </section>
          </ScrollReveal>

          {/* ── SECTION 10 — Lead Capture ───────────────────────────── */}
          <section className="py-20 px-6 lg:px-12">
            <div className="max-w-2xl mx-auto text-center">
              <ScrollReveal>
                <h2 className="text-3xl font-bold text-mine-slate-900 mb-4">
                  Ready to migrate from {src} to {tgt}?
                </h2>
                <p className="text-mine-slate-500 mb-4">
                  Tell us about your migration and we'll show you how Mine can help.
                </p>
                <p className="text-sm text-mine-slate-400 mb-6">
                  No commitment required. We'll review your migration scope and share a preliminary assessment within 48 hours.
                </p>
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
