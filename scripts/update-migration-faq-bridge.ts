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

async function updatePages() {
  const filePath = resolve(process.cwd(), 'scripts/data/migration-pages-faq-bridge-updates.json')
  const updates = JSON.parse(readFileSync(filePath, 'utf-8'))

  for (const update of updates) {
    const { slug, bridge_paragraph, faqs } = update

    const { error } = await supabase
      .from('migration_pages')
      .update({ bridge_paragraph, faqs })
      .eq('slug', slug)

    if (error) {
      console.error(`Failed to update ${slug}:`, error.message)
    } else {
      console.log(`Updated ${slug}`)
    }
  }

  console.log(`\nDone — ${updates.length} pages updated.`)
}

updatePages()