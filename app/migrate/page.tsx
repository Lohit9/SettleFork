import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

import Header from '@/components/Header'
import Footer from '@/components/Footer'
import MigrationDirectory from '@/components/migrate/MigrationDirectory'

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

  return (
    <div className="min-h-screen bg-white">
      <Header />

      <main>
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="max-w-2xl mx-auto py-12 px-6 text-center">
          <h1 className="text-4xl font-bold text-mine-slate-900 tracking-tight mb-4">
            Data Migration Paths
          </h1>
          <p className="text-lg text-mine-slate-500 leading-relaxed">
            Explore Mine's automated migration paths across enterprise systems. Filter by source or target to find yours.
          </p>
        </section>

        {/* ── Directory (client component with filters) ────────── */}
        <MigrationDirectory pages={pages} />

        {/* ── Bottom CTA ───────────────────────────────────────── */}
        <section className="py-12 px-6 text-center">
          <p className="text-lg font-medium text-mine-slate-700">
            Don't see your migration path?
          </p>
          <p className="text-sm text-mine-slate-500 mt-2">
            Mine supports any source-to-target combination. Tell us about your migration.
          </p>
          <Link
            href="/request-access?ref=assessment"
            className="inline-block bg-mine-blue-600 hover:bg-mine-blue-700 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25 mt-4"
          >
            Get Your Free Assessment
          </Link>
        </section>
      </main>

      <Footer />
    </div>
  )
}
