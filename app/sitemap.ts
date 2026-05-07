import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'

const BASE_URL = 'https://usesettle.ai'

const STATIC_PAGES: MetadataRoute.Sitemap = [
  { url: `${BASE_URL}/`,             lastModified: new Date(), changeFrequency: 'weekly',  priority: 1.0 },
  { url: `${BASE_URL}/migrate`,      lastModified: new Date(), changeFrequency: 'weekly',  priority: 0.9 },
  { url: `${BASE_URL}/pricing`,      lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
  { url: `${BASE_URL}/how-it-works`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
  { url: `${BASE_URL}/careers`,      lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
  { url: `${BASE_URL}/careers/co-founder-cto`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.4 },
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const { data } = await supabase
    .from('migration_pages')
    .select('slug, updated_at')
    .eq('is_published', true)

  const migrationPages: MetadataRoute.Sitemap = (data ?? []).map(
    (row: { slug: string; updated_at: string | null }) => ({
      url: `${BASE_URL}/migrate/${row.slug}`,
      lastModified: row.updated_at ? new Date(row.updated_at) : new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })
  )

  return [...STATIC_PAGES, ...migrationPages]
}
