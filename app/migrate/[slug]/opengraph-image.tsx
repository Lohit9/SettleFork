import { ImageResponse } from 'next/og'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'
export const alt = 'Mine — AI-powered data migration'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

async function getPageData(slug: string) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const { data } = await supabase
    .from('migration_pages')
    .select('source_system, target_system')
    .eq('slug', slug)
    .eq('is_published', true)
    .single()

  return data as { source_system: string; target_system: string } | null
}

export default async function OGImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const page = await getPageData(slug)

  const source = page?.source_system ?? 'Source'
  const target = page?.target_system ?? 'Target'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#0F172A',
          padding: '60px 80px',
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              backgroundColor: '#2563EB',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: '18px',
              fontWeight: 700,
            }}
          >
            M
          </div>
          <span style={{ color: 'white', fontSize: '24px', fontWeight: 700 }}>Mine</span>
        </div>

        {/* Center content */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0px' }}>
          <div
            style={{
              color: 'white',
              fontSize: '60px',
              fontWeight: 700,
              textAlign: 'center',
              lineHeight: 1.15,
            }}
          >
            {source} → {target}
          </div>

          {/* Decorative line */}
          <div
            style={{
              width: '120px',
              height: '3px',
              backgroundColor: '#2563EB',
              borderRadius: '4px',
              marginTop: '28px',
              marginBottom: '28px',
            }}
          />

          <div style={{ color: '#94A3B8', fontSize: '28px', fontWeight: 500 }}>
            Data Migration
          </div>
        </div>

        {/* Footer URL */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <span style={{ color: '#64748B', fontSize: '16px' }}>
            trymine.ai/migrate/{slug}
          </span>
        </div>
      </div>
    ),
    { ...size }
  )
}
