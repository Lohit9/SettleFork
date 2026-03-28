import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from 'dotenv'

// Load .env.local
config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  const dataPath = resolve(process.cwd(), 'scripts/data/migration-pages.json')
  const raw = readFileSync(dataPath, 'utf-8')
  const pages: Record<string, unknown>[] = JSON.parse(raw)

  if (!Array.isArray(pages)) {
    console.error('migration-pages.json must contain a JSON array')
    process.exit(1)
  }

  const total = pages.length
  if (total === 0) {
    console.log('No entries found in migration-pages.json — nothing to seed.')
    return
  }

  let seeded = 0

  for (let i = 0; i < pages.length; i++) {
    const entry = pages[i]
    const slug = entry.slug as string | undefined

    if (!slug) {
      console.warn(`[${i + 1}/${total}] Skipping entry with missing slug:`, JSON.stringify(entry))
      continue
    }

    const { error } = await supabase
      .from('migration_pages')
      .upsert({ ...entry, is_published: true }, { onConflict: 'slug' })

    if (error) {
      console.error(`Failed to seed slug "${slug}": ${error.message}`)
      continue
    }

    seeded++
    console.log(`Seeded ${seeded} of ${total}: ${slug}`)
  }

  console.log(`\nDone. ${seeded}/${total} entries seeded successfully.`)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
