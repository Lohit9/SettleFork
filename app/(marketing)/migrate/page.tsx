import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'

import Header from '@/components/Header'
import Footer from '@/components/Footer'
import MigrationDirectory from '@/components/migrate/MigrationDirectory'

export const revalidate = 3600

export const metadata: Metadata = {
  title: 'Enterprise data migration paths — automated by AI | Settle',
  description:
    'Browse 100+ automated migration paths across SAP, Oracle EBS, NetSuite, Salesforce, HubSpot, and more. AI-powered schema mapping, SQL generation, and validation — delivered in weeks, not months.',
  alternates: { canonical: 'https://settledata.ai/migrate' },
  openGraph: {
    title: 'Enterprise data migration paths — automated by AI',
    description:
      'Browse 100+ automated migration paths. AI-powered schema mapping, SQL generation, and validation across SAP, Oracle, Salesforce, NetSuite, and more.',
    url: 'https://settledata.ai/migrate',
    siteName: 'Settle',
    type: 'website',
    images: [
      {
        url: 'https://settledata.ai/images/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Settle — Enterprise data migration paths',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Enterprise data migration paths — automated by AI',
    description:
      'Browse 100+ automated migration paths. AI-powered schema mapping, SQL generation, and validation across SAP, Oracle, Salesforce, NetSuite, and more.',
    images: ['https://settledata.ai/images/og-image.png'],
  },
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

export default async function MigrateIndexPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const initialSource = typeof searchParams.source === 'string' ? searchParams.source : ''
  const initialTarget = typeof searchParams.target === 'string' ? searchParams.target : ''

  const pages = await getAllMigrationPages()

  const itemListSchema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Enterprise data migration paths automated by Settle',
    description:
      'AI-powered migration paths from SAP, Oracle EBS, NetSuite, Salesforce, and more — with automated schema mapping, SQL generation, and validation.',
    numberOfItems: pages.length,
    itemListElement: pages.slice(0, 50).map((page, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: `${page.source_system} to ${page.target_system} migration`,
      url: `https://settledata.ai/migrate/${page.slug}`,
    })),
  }

  return (
    <div className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListSchema) }}
      />
      <Header />

      <main>
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="max-w-2xl mx-auto py-12 px-6 text-center">
          <h1 className="text-4xl font-bold text-settle-slate-900 tracking-tight mb-4">
            Enterprise data migration paths
          </h1>
          <p className="text-lg text-settle-slate-500 leading-relaxed">
            100+ source-to-target migration paths, automated by AI. Filter by source or target system to find yours.
          </p>
        </section>

        {/* ── Directory (client component with filters) ────────── */}
        <MigrationDirectory
            pages={pages}
            initialSource={initialSource}
            initialTarget={initialTarget}
          />

        {/* ── Bottom CTA ───────────────────────────────────────── */}
        <section className="py-12 px-6 text-center">
          <p className="text-lg font-medium text-settle-slate-700">
            Don't see your migration path?
          </p>
          <p className="text-sm text-settle-slate-500 mt-2">
            Settle supports any source-to-target combination. Tell us about your migration.
          </p>
          <Link
            href="/request-access?ref=assessment"
            className="inline-block bg-settle-blue-600 hover:bg-settle-blue-700 text-white text-sm font-semibold px-6 py-3 rounded-lg transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-600/25 mt-4"
          >
            Get Your Free Assessment
          </Link>
        </section>
      </main>

      <Footer />
    </div>
  )
}
