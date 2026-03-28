import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

import Header from '@/components/Header'
import Footer from '@/components/Footer'
import ScrollReveal from '@/components/ui/ScrollReveal'

export const revalidate = 3600

export const metadata: Metadata = {
  title: 'Data Migration Paths | Mine',
  description:
    'Explore automated migration paths for SAP, Oracle, NetSuite, Salesforce, and more. AI-powered schema mapping and validation.',
  alternates: { canonical: 'https://trymine.ai/migrate' },
}

interface MigrationPageRow {
  slug: string
  source_system: string
  target_system: string
  source_category: string | null
  target_category: string | null
  display_order: number | null
}

async function getAllMigrationPages(): Promise<MigrationPageRow[]> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const { data } = await supabase
    .from('migration_pages')
    .select('slug, source_system, target_system, source_category, target_category, display_order')
    .eq('is_published', true)
    .order('display_order', { ascending: true, nullsFirst: false })

  return (data ?? []) as MigrationPageRow[]
}

export default async function MigrateIndexPage() {
  const pages = await getAllMigrationPages()

  // Group by target_system, preserving insertion order
  const groups = new Map<string, MigrationPageRow[]>()
  for (const page of pages) {
    const key = page.target_system
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(page)
  }

  return (
    <div className="min-h-screen bg-white">
      <Header />

      <main>
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="max-w-4xl mx-auto py-20 px-6 text-center">
          <ScrollReveal>
            <h1 className="text-4xl font-bold text-mine-slate-900 tracking-tight mb-4">
              Data Migration Paths
            </h1>
            <p className="text-lg text-mine-slate-500 max-w-2xl mx-auto mb-12 leading-relaxed">
              Explore Mine's automated migration paths across enterprise systems. Every migration
              is AI-powered with schema profiling, auto-mapping, and validation.
            </p>
          </ScrollReveal>
        </section>

        {/* ── Groups ───────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 lg:px-12 pb-20 space-y-14">
          {groups.size === 0 ? (
            <p className="text-center text-mine-slate-400 py-12">No migration paths published yet.</p>
          ) : (
            Array.from(groups.entries()).map(([targetSystem, rows], groupIdx) => (
              <ScrollReveal key={targetSystem} delay={groupIdx * 0.04}>
                <h2 className="text-xl font-bold text-mine-slate-900 mb-4">
                  Migrate to {targetSystem}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {rows.map((page) => (
                    <Link
                      key={page.slug}
                      href={`/migrate/${page.slug}`}
                      className="bg-white rounded-xl p-5 border border-mine-slate-200 hover:-translate-y-1 hover:shadow-lg transition-all flex flex-col gap-2"
                    >
                      <p className="text-base font-semibold text-mine-slate-900 leading-snug">
                        {page.source_system}
                      </p>
                      <p className="text-sm text-mine-teal-600">→ {page.target_system}</p>
                      {page.source_category && (
                        <span className="self-start bg-mine-slate-100 text-mine-slate-500 text-xs px-2 py-0.5 rounded-full">
                          {page.source_category}
                        </span>
                      )}
                    </Link>
                  ))}
                </div>
              </ScrollReveal>
            ))
          )}
        </section>

        {/* ── Bottom CTA ───────────────────────────────────────── */}
        <section className="bg-mine-slate-50 py-16 px-6 lg:px-12">
          <ScrollReveal className="max-w-2xl mx-auto text-center">
            <h2 className="text-2xl font-bold text-mine-slate-900 mb-3">
              Don't see your migration path?
            </h2>
            <p className="text-mine-slate-500 mb-8">
              Contact us and we'll scope your migration — Mine supports any structured source and
              target with a defined schema.
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
              <a
                href="mailto:hello@trymine.ai"
                className="border border-mine-slate-200 text-mine-slate-700 hover:border-mine-blue-400 hover:text-mine-blue-600 text-sm font-semibold px-6 py-3 rounded-lg transition-all"
              >
                Contact Us
              </a>
            </div>
          </ScrollReveal>
        </section>
      </main>

      <Footer />
    </div>
  )
}
